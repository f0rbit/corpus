/**
 * @module testing/laws/functor
 * @description Functor law checking — identity and composition properties.
 *
 * A functor must satisfy two laws:
 * 1. **Identity**: `map(x, id) === x`
 * 2. **Composition**: `map(map(x, f), g) === map(x, g ∘ f)`
 *
 * This checker is generic over the functor instance — it does not import Result
 * or any specific type. `T` is the functor value (e.g. `Result<number, string>`),
 * `A` is the wrapped element type the mapped functions operate on (e.g. `number`).
 * Both flow through inference from `arb` and `fn_arb`, so call sites need no
 * casts. Callers provide:
 * - An arbitrary to generate test values
 * - A `map(value, fn): mapped_value` operation
 * - An `equals(a, b): boolean` equality predicate
 * - An arbitrary of endomorphisms `(x: A) => A`
 *
 * Each law runs separately; shrinking is disabled (`endOnFailure: true`) due to
 * potential issues with composed arbitraries (same rationale as
 * `error_path_exhaustive`).
 *
 * @example
 * ```ts
 * import { testing } from "@f0rbit/corpus";
 * import { pipe } from "./result.js";
 *
 * await testing.law.functor({
 *   arb: result_arb,
 *   map: (value, fn) => pipe(value).map(fn).result(),
 *   equals: (a, b) => deepEqual(a, b),
 *   fn_arb: testing.fc.func<[number], number>(testing.fc.integer()),
 *   numRuns: 200,
 * });
 * ```
 */

import fc from "fast-check";
import type { Arbitrary } from "fast-check";

/**
 * Options for the functor law checker.
 *
 * - `arb`      — Arbitrary for generating functor values (`T`).
 * - `map`      — The functor's map operation: `(value, fn) => mapped_value`.
 *                Can be sync or async (must return Promise for async).
 * - `equals`   — Equality predicate for comparing mapped results.
 *                Can be sync or async.
 * - `fn_arb`   — Arbitrary of endomorphisms on the wrapped element type (`A → A`).
 * - `numRuns`  — Number of property runs (default: 200).
 */
export type FunctorLawOpts<T, A> = {
	arb: Arbitrary<T>;
	map: (value: T, fn: (x: A) => A) => T | Promise<T>;
	equals: (a: T, b: T) => boolean | Promise<boolean>;
	fn_arb: Arbitrary<(x: A) => A>;
	numRuns?: number;
};

const DEFAULT_NUM_RUNS = 200;

/**
 * Check the identity and composition laws for a functor.
 *
 * Generates test values and function pairs, then asserts:
 * 1. **Identity law**: `map(x, id) === x` (where `id(x) = x`)
 * 2. **Composition law**: `map(map(x, f), g) === map(x, g ∘ f)`
 *
 * If either law fails, the property failure is reported with fast-check's
 * standard counterexample output. Coverage is implicit — both ok and err
 * branches of the generated values are exercised by the caller's arbitrary.
 *
 * @param opts - Configuration object (see {@link FunctorLawOpts})
 */
export async function functor<T, A>(opts: FunctorLawOpts<T, A>): Promise<void> {
	const num_runs = opts.numRuns ?? DEFAULT_NUM_RUNS;

	// Identity law: map(x, id) === x
	await fc.assert(
		fc.asyncProperty(opts.arb, async (x) => {
			const mapped = await Promise.resolve(opts.map(x, (a) => a));
			const is_equal = await Promise.resolve(opts.equals(x, mapped));
			if (!is_equal) {
				throw new Error(
					`functor identity law failed: map(x, id) !== x\n` +
						`  original: ${JSON.stringify(x)}\n` +
						`  mapped:   ${JSON.stringify(mapped)}`,
				);
			}
		}),
		{ numRuns: num_runs, endOnFailure: true },
	);

	// Composition law: map(map(x, f), g) === map(x, g ∘ f)
	await fc.assert(
		fc.asyncProperty(opts.arb, opts.fn_arb, opts.fn_arb, async (x, f, g) => {
			// Left side: map(map(x, f), g)
			const map_f = await Promise.resolve(opts.map(x, f));
			const left = await Promise.resolve(opts.map(map_f, g));

			// Right side: map(x, g ∘ f)
			const composed = (a: A): A => g(f(a));
			const right = await Promise.resolve(opts.map(x, composed));

			// Check equality
			const is_equal = await Promise.resolve(opts.equals(left, right));
			if (!is_equal) {
				throw new Error(
					`functor composition law failed: map(map(x, f), g) !== map(x, g ∘ f)\n` +
						`  left:  ${JSON.stringify(left)}\n` +
						`  right: ${JSON.stringify(right)}`,
				);
			}
		}),
		{ numRuns: num_runs, endOnFailure: true },
	);
}
