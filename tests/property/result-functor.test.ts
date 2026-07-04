/**
 * @module tests/property/result-functor
 * @description Pilot test for the functor laws against Result<T, E>.
 *
 * Tests that Result satisfies the two functor laws:
 * 1. Identity: `pipe(x).map(id).result() === x`
 * 2. Composition: `pipe(pipe(x).map(f).result()).map(g).result() === pipe(x).map(g ∘ f).result()`
 *
 * Uses the actual `pipe(...).map(...)` API from corpus (not a stub) and the
 * real `ok`/`err` constructors — no casts anywhere; `functor`'s `<T, A>`
 * generics flow through inference.
 * Generates Result<number, string> with 50/50 ok/err split.
 * Coverage checks ensure both branches fire ≥20%.
 */

import { describe, it } from "bun:test";
import { testing } from "../../index.js";
import { pipe } from "../../result.js";
import { ok, err } from "../../types.js";
import type { Result } from "../../types.js";

const result_arb = testing.fc.oneof(
	testing.fc.integer().map((n): Result<number, string> => ok(n)),
	testing.fc.string().map((s): Result<number, string> => err(s)),
);

const fn_arb = testing.fc.func<[number], number>(testing.fc.integer());

const map_result = (result: Result<number, string>, fn: (x: number) => number): Promise<Result<number, string>> =>
	pipe(result).map(fn).result();

const equals_result = (a: Result<number, string>, b: Result<number, string>): boolean => {
	if (a.ok !== b.ok) return false;
	if (a.ok && b.ok) return a.value === b.value;
	if (!a.ok && !b.ok) return a.error === b.error;
	return false;
};

describe("functor laws — Result<number, string>", () => {
	it("identity + composition laws (200 runs, 50/50 ok/err)", async () => {
		await testing.law.functor({
			arb: result_arb,
			map: map_result,
			equals: equals_result,
			fn_arb,
			numRuns: 200,
		});
	});

	it("coverage: both ok and err branches fire ≥20%", async () => {
		await testing.cover(result_arb, () => true, {
			labels: [
				{
					name: "ok branch",
					min_percent: 20,
					matches: (r) => r.ok,
				},
				{
					name: "err branch",
					min_percent: 20,
					matches: (r) => !r.ok,
				},
			],
			numRuns: 200,
		});
	});
});
