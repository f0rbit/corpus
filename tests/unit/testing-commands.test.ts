import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { commands, async_commands, async_model_run } from "../../testing/commands.js";
import type { AsyncCommand } from "../../testing/commands.js";
import { provider_equivalence, equivalence_command } from "../../testing/laws/provider-equivalence.js";
import { ok, err } from "../../types.js";
import type { Result } from "../../types.js";

type CounterError = { kind: "overflow" };
type CounterResult = Result<number, CounterError>;
type CounterModel = { count: number };
type Counter = {
	increment: () => CounterResult;
	add: (n: number) => CounterResult;
	read: () => CounterResult;
};

const CAP = 10;

const make_correct = (): Counter => {
	let value = 0;
	return {
		increment: () => {
			if (value + 1 > CAP) return err({ kind: "overflow" });
			value += 1;
			return ok(value);
		},
		add: (n) => {
			if (value + n > CAP) return err({ kind: "overflow" });
			value += n;
			return ok(value);
		},
		read: () => ok(value),
	};
};

// Correct until increment pushes the value past 1, then drifts by one.
const make_off_by_one = (): Counter => {
	let value = 0;
	return {
		increment: () => {
			if (value + 1 > CAP) return err({ kind: "overflow" });
			value += 1;
			if (value > 1) value += 1;
			return ok(value);
		},
		add: (n) => {
			if (value + n > CAP) return err({ kind: "overflow" });
			value += n;
			return ok(value);
		},
		read: () => ok(value),
	};
};

const increment_command = equivalence_command<CounterModel, Counter, CounterResult>({
	label: "increment()",
	on_model: (m) => {
		if (m.count + 1 > CAP) return err({ kind: "overflow" });
		m.count += 1;
		return ok(m.count);
	},
	on_sut: (c) => c.increment(),
});

// Payload from a PLAIN fc arbitrary — compose-based payloads don't shrink safely.
const add_commands = fc.integer({ min: 1, max: 5 }).map((n) =>
	equivalence_command<CounterModel, Counter, CounterResult>({
		label: `add(${String(n)})`,
		on_model: (m) => {
			if (m.count + n > CAP) return err({ kind: "overflow" });
			m.count += n;
			return ok(m.count);
		},
		on_sut: (c) => c.add(n),
	}),
);

const read_command = equivalence_command<CounterModel, Counter, CounterResult>({
	label: "read()",
	on_model: (m) => ok(m.count),
	on_sut: (c) => c.read(),
});

// Hand-rolled self-asserting command — exercises the vanilla AsyncCommand path
// (no outcome deposited, so the law skips the centralized comparison for it).
const vanilla_noop: AsyncCommand<CounterModel, Counter> = {
	check: () => true,
	run: async () => {},
	toString: () => "noop()",
};

const results_agree = (a: unknown, b: unknown): boolean => a === b;

describe("testing/commands typed re-exports", () => {
	test("commands surface is pinned and callable", () => {
		expect(typeof commands).toBe("function");
		expect(typeof async_commands).toBe("function");
		expect(typeof async_model_run).toBe("function");
	});
});

describe("testing.law.provider_equivalence", () => {
	test("correct pair passes 200/200 with fresh model + fresh SUT per run", async () => {
		let model_builds = 0;
		let sut_builds = 0;

		await provider_equivalence({
			model: () => {
				model_builds += 1;
				return { count: 0 };
			},
			providers: [
				{
					label: "correct",
					build: () => {
						sut_builds += 1;
						return make_correct();
					},
				},
			],
			commands: [increment_command, add_commands, read_command, vanilla_noop],
			equivalence: { results_agree },
			numRuns: 200,
			maxCommands: 15,
		});

		expect(model_builds).toBe(200);
		expect(sut_builds).toBe(200);
	});

	test("finds the off-by-one and shrinks to a minimal command sequence", async () => {
		let thrown: unknown;
		try {
			await provider_equivalence({
				model: () => ({ count: 0 }),
				providers: [
					{ label: "correct", build: make_correct },
					{ label: "off_by_one", build: make_off_by_one },
				],
				commands: [increment_command, add_commands, read_command],
				equivalence: { results_agree },
				numRuns: 200,
				maxCommands: 15,
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("Counterexample");

		// fast-check 4.x attaches the property's error as `cause` — that's our
		// divergence message from the SHRUNK (minimal) run.
		const cause = (thrown as Error).cause;
		expect(cause).toBeInstanceOf(Error);
		const message = (cause as Error).message;

		expect(message).toContain('provider "off_by_one"');
		expect(message).not.toContain('provider "correct"');
		expect(message).toContain("command #");
		expect(message).toContain("ok values disagree");

		const shrunk_match = message.match(/sequence: \[([^\]]*)\]/);
		expect(shrunk_match).not.toBeNull();
		const shrunk = (shrunk_match?.[1] ?? "").split(", ").filter((s) => s.length > 0);

		expect(shrunk.length).toBeGreaterThanOrEqual(1);
		expect(shrunk.length).toBeLessThanOrEqual(2);
		expect(shrunk[shrunk.length - 1]).toBe("increment()");
	});

	test("rejects a model factory that reuses instances", async () => {
		const shared: CounterModel = { count: 0 };
		let thrown: unknown;
		try {
			await provider_equivalence({
				model: () => shared,
				providers: [
					{ label: "a", build: make_correct },
					{ label: "b", build: make_correct },
				],
				commands: [increment_command],
				equivalence: { results_agree },
				numRuns: 5,
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(String((thrown as Error).cause)).toContain("FRESH model per call");
	});

	test("type-level: commands must share the Model/S generics", () => {
		type OtherModel = { other: string };
		const wrong_model_command = equivalence_command<OtherModel, Counter, number>({
			label: "wrong()",
			on_model: (m) => m.other.length,
			on_sut: () => 0,
		});

		// Compile-time only — never invoked.
		const misuse = async (): Promise<void> => {
			await provider_equivalence<CounterModel, Counter>({
				model: () => ({ count: 0 }),
				providers: [{ label: "correct", build: make_correct }],
				// @ts-expect-error — AsyncCommand<OtherModel, Counter> must not mix into AsyncCommand<CounterModel, Counter>[]
				commands: [increment_command, wrong_model_command],
				equivalence: { results_agree },
				numRuns: 1,
			});
		};
		void misuse;

		expect(typeof wrong_model_command.run).toBe("function");
	});
});
