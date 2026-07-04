/**
 * @module testing/laws/error-path-exhaustive
 * @description Headline law: every tagged error variant a function can return
 * is exercised against a registered failure generator.
 *
 * The mapped-type `provoke: { [K in E["kind"]]: ... }` shape is the compile-time
 * exhaustiveness guarantee — adding a variant to `E` without updating `provoke`
 * is a TypeScript error at the call site. The runtime guarantee is that every
 * variant that gets exercised has a registered failure generator (registered via
 * `testing.failure(brand, kind, gen)`); a missing generator throws an actionable
 * error pointing at the exact registration call.
 *
 * Per-variant property runs are independent — `fc.assert` is called once per
 * variant, so a counterexample under one variant doesn't poison another's run.
 *
 * Shrinking is disabled (`endOnFailure: true`). Failure generators are
 * registered via `testing.compose`, which is built on `fc.gen()` — and
 * `fc.gen()`'s shrinker does not reliably terminate (observed unbounded on
 * fast-check 4.8 even for a single-draw generator). A failing variant still
 * throws fast-check's normal counterexample report; it just isn't shrunk.
 */

import fc from "fast-check";
import { lookup_failure } from "../failure.js";
import type { ArbBrand } from "../types.js";
import type { Result } from "../../types.js";

/**
 * Default per-variant runs. Each variant gets its own `fc.assert` call, so the
 * total work is `variants * default_runs`. 50 keeps a 12-variant union (the
 * corpus error case) under a couple of seconds on a warm machine.
 */
const DEFAULT_NUM_RUNS = 50;

/**
 * Assert that `fn` correctly surfaces every variant of its error union when
 * provoked with the corresponding inputs.
 *
 * For each variant kind in `E["kind"]` (filtered by `opts.only` when present):
 *
 * 1. Look up the registered failure generator via `lookup_failure(opts.error_brand, kind)`.
 * 2. If missing, throw a clear error naming the brand, the variant, and the
 *    exact `testing.failure(...)` call needed to register it.
 * 3. Otherwise run `fc.assert(fc.asyncProperty(gen, async (failure) => { ... }))`
 *    where the property body calls `fn(...opts.provoke[failure.kind](failure))`
 *    and asserts the result is an `err` with matching `kind`.
 *
 * @example
 * ```ts
 * await testing.law.error_path_exhaustive(store_get, {
 *   error_brand: CORPUS_ERROR_BRAND,
 *   provoke: {
 *     not_found: (f) => [{ store_id: f.store_id, version: f.version }],
 *     decode_error: (f) => [pre_seed_corrupt_bytes(f)],
 *     // ...one entry per variant; missing entries are TS errors
 *   },
 *   only: ["not_found", "decode_error"],
 *   numRuns: 200,
 * });
 * ```
 */
export async function error_path_exhaustive<Args extends readonly unknown[], T, E extends { kind: string }>(
	fn: (...args: Args) => Promise<Result<T, E>>,
	opts: {
		error_brand: ArbBrand<E>;
		// NoInfer is load-bearing twice over: (1) it stops the provoke fns'
		// return literals from becoming inference candidates for `Args`, so
		// array literals get checked contextually against the tuple type and
		// don't widen to `T[]`; (2) it pins `E` to what `fn` + `error_brand`
		// declare, so a provoke table missing a variant is a hard compile
		// error instead of narrowing `E["kind"]` to the keys provided.
		provoke: NoInfer<{ [K in E["kind"]]: (failure: Extract<E, { kind: K }>) => Args }>;
		only?: readonly E["kind"][];
		numRuns?: number;
	},
): Promise<void> {
	const num_runs = opts.numRuns ?? DEFAULT_NUM_RUNS;
	const variants = (opts.only ?? (Object.keys(opts.provoke) as E["kind"][])) as readonly E["kind"][];

	for (const variant of variants) {
		const gen = await lookup_failure(opts.error_brand, variant);
		if (!gen) {
			throw new Error(
				`error_path_exhaustive: no generator registered for variant '${variant}' of brand ${String(opts.error_brand)} — register via testing.failure(brand, '${variant}', () => ...)`,
			);
		}

		await fc.assert(
			fc.asyncProperty(gen, async (failure) => {
				// `provoke[failure.kind]` is typed as the union of all provoke
				// fns; TS can't narrow it to the specific `Extract<E, { kind: K }>`
				// callback after the runtime index. Cast here is the single
				// escape hatch — `failure.kind === variant` by construction
				// because `gen` was looked up under `variant`.
				const provoke_fn = opts.provoke[failure.kind as E["kind"]] as (f: E) => Args;
				const args = provoke_fn(failure);
				const result = await fn(...args);
				// Plain throws, NOT bun:test's `expect` — this module ships in the
				// published package via the main barrel (`index.ts` re-exports
				// `testing`), so it must not import `bun:test` (unresolvable under
				// Node / workerd). fast-check surfaces thrown errors as property
				// failures with the counterexample attached.
				if (result.ok) {
					throw new Error(`error_path_exhaustive: provoked variant '${failure.kind}' but fn returned ok`);
				}
				if (result.error.kind !== failure.kind) {
					throw new Error(
						`error_path_exhaustive: provoked variant '${failure.kind}' but fn returned error kind '${result.error.kind}'`,
					);
				}
			}),
			{ numRuns: num_runs, endOnFailure: true },
		);
	}
}
