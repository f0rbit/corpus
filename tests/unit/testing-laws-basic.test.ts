/**
 * Unit tests for the testing.law helpers: passing examples, plus a table of
 * deliberately violated laws that must each fail with an actionable message.
 */

import { test, expect } from "bun:test";
import * as testing from "../../testing/index.js";
import { default_equals } from "../../testing/laws/equality.js";

const json_codec = {
	encode: (x: unknown) => new TextEncoder().encode(JSON.stringify(x)),
	decode: (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes)),
};

const json_cases = [
	testing.fc.string(),
	testing.fc.integer(),
	testing.fc.record({ name: testing.fc.string(), age: testing.fc.integer({ min: 0, max: 150 }) }),
] as const;

const strict_equals = (a: unknown, b: unknown): boolean => a === b;
const custom_equals = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const broken_encode = (_x: string) => new Uint8Array([0, 1, 2]);
const broken_decode = () => "always_same";

type Counter = { count: number; drift: number };
type Step = { ok: true; value: number };

const increment = testing.law.equivalence_command<Counter, Counter, Step>({
	label: "increment()",
	on_model: (m) => {
		m.count += 1;
		return { ok: true, value: m.count };
	},
	on_sut: (s) => {
		s.count += 1;
		return { ok: true, value: s.count + s.drift };
	},
});

const counter_law = (drift: number) =>
	testing.law.provider_equivalence<Counter, Counter>({
		model: () => ({ count: 0, drift: 0 }),
		providers: [{ label: "counter", build: () => ({ count: 0, drift }) }],
		commands: [increment],
		equivalence: { results_agree: strict_equals },
		numRuns: 30,
		maxCommands: 5,
	});

const failure_text = async (run: () => Promise<void>): Promise<string> => {
	const outcome = await run().then(
		() => undefined,
		(e: unknown) => e,
	);
	if (!(outcome instanceof Error)) throw new Error("expected the law to fail, but it passed");
	const cause = outcome.cause instanceof Error ? outcome.cause.message : "";
	return `${outcome.message}\n${cause}`;
};

const violated_laws = [
	[
		"round_trip: lossy decode",
		"round_trip",
		() =>
			testing.law.round_trip(
				testing.fc.string({ minLength: 1 }),
				(s) => s,
				(s) => `${s}!`,
				{ equals: strict_equals },
			),
	],
	[
		"round_trip: default equality notices a mismatch",
		"round_trip",
		() => testing.law.round_trip(testing.fc.string({ minLength: 1 }), broken_encode, broken_decode, { numRuns: 10 }),
	],
	[
		"idempotent: appending is not idempotent",
		"idempotent",
		() => testing.law.idempotent(testing.fc.string(), (x) => `${x}a`, { equals: strict_equals }),
	],
	[
		"functor: constant map breaks identity",
		"functor identity law",
		() =>
			testing.law.functor<number, number>({
				arb: testing.fc.integer({ min: 1, max: 10 }),
				map: () => 0,
				equals: strict_equals,
				fn_arb: testing.fc.func<[number], number>(testing.fc.integer()),
			}),
	],
	[
		"functor: applying fn twice breaks composition",
		"functor composition law",
		() =>
			testing.law.functor<number, number>({
				arb: testing.fc.integer(),
				map: (x, fn) => fn(fn(x)),
				equals: strict_equals,
				fn_arb: testing.fc.func<[number], number>(testing.fc.integer()),
			}),
	],
	["provider_equivalence: SUT disagrees with model", "ok values disagree", () => counter_law(1000)],
] as const;

test("round_trip: JSON codec over string, integer and object", async () => {
	await Promise.all(json_cases.map((arb) => testing.law.round_trip(arb, json_codec.encode, json_codec.decode)));
});

test("idempotent: string trim", async () => {
	await testing.law.idempotent(testing.fc.string(), (s) => s.trim());
});

test("round_trip: JSON with custom equals", async () => {
	await testing.law.round_trip(
		testing.fc.object({ withMap: false, withSet: false, maxDepth: 2 }),
		json_codec.encode,
		json_codec.decode,
		{ equals: custom_equals, numRuns: 50 },
	);
});

test("provider_equivalence: an honest SUT agrees with the model", async () => {
	await counter_law(0);
});

test("default_equals: without Bun it throws naming the law and opts.equals", () => {
	expect(() => default_equals("round_trip", false)).toThrow(/round_trip.*opts\.equals/);
});

test("default_equals: with Bun it deep-compares", () => {
	const equals = default_equals<unknown>("x", true);
	expect(equals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
	expect(equals({ a: [1] }, { a: [2] })).toBe(false);
});

for (const [label, needle, run] of violated_laws) {
	test(`law fails when violated: ${label}`, async () => {
		expect(await failure_text(run)).toContain(needle);
	});
}
