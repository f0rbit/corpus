/**
 * @module tests/property/result-functor
 * @description Pilot test for the functor laws against Result<T, E>.
 *
 * Tests that Result satisfies the two functor laws:
 * 1. Identity: `pipe(x).map(id).result() === x`
 * 2. Composition: `pipe(pipe(x).map(f).result()).map(g).result() === pipe(x).map(g ∘ f).result()`
 *
 * Uses the actual `pipe(...).map(...)` API from corpus (not a stub).
 * Generates Result<number, string> with 50/50 ok/err split.
 * Coverage checks ensure both branches fire ≥20%.
 */

import { describe, it } from "bun:test";
import { testing } from "../../index.js";
import { pipe } from "../../result.js";
import type { Result } from "../../types.js";

describe("functor laws — Result<number, string>", () => {
	it("identity + composition laws (200 runs, 50/50 ok/err)", async () => {
		// Arbitrary for Result<number, string> with 50/50 ok/err split
		const result_arb = testing.fc.oneof(
			testing.fc.integer().map((n) => ({ ok: true, value: n } as const)),
			testing.fc.string().map((s) => ({ ok: false, error: s } as const)),
		) as unknown as testing.fc.Arbitrary<Result<number, string>>;

		// Arbitrary for endomorphic functions (number → number)
		const fn_arb = testing.fc.func(testing.fc.integer());

		// Wrapper to use the actual pipe(...).map(...) API from corpus
		const map_result = async (
			result: Result<number, string>,
			fn: (x: unknown) => unknown,
		): Promise<Result<number, string>> => {
			return await pipe(result).map((n) => fn(n) as number).result();
		};

		// Hand-rolled structural equality for Result
		const equals_result = (
			a: Result<number, string>,
			b: Result<number, string>,
		): boolean => {
			if (a.ok !== b.ok) return false;
			if (a.ok && b.ok) return a.value === b.value;
			if (!a.ok && !b.ok) return a.error === b.error;
			return false;
		};

		// Run the functor laws
		await testing.law.functor({
			arb: result_arb,
			map: map_result,
			equals: equals_result,
			fn_arb,
			numRuns: 200,
		});
	});

	it("coverage: both ok and err branches fire ≥20%", async () => {
		const result_arb = testing.fc.oneof(
			testing.fc.integer().map((n) => ({ ok: true, value: n } as const)),
			testing.fc.string().map((s) => ({ ok: false, error: s } as const)),
		) as unknown as testing.fc.Arbitrary<Result<number, string>>;

		await testing.cover(result_arb, (result) => true, {
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
