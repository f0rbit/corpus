/**
 * @module testing/laws
 * @description Property-based law helpers. Each law is a higher-order assertion
 * that drives a generator + predicate combo through fast-check and surfaces a
 * structured failure when the law is violated.
 *
 * Re-exported from `testing/index.ts` under the `law` namespace —
 * `testing.law.round_trip(...)` / `testing.law.provider_equivalence(...)` are
 * the canonical call paths.
 *
 * Each law carries its own default run count tuned to its cost profile
 * (documented per module); pass `numRuns` to override.
 */

export { error_path_exhaustive } from "./error-path-exhaustive.js";
export { round_trip } from "./round-trip.js";
export { idempotent } from "./idempotent.js";
export { provider_equivalence, equivalence_command } from "./provider-equivalence.js";
export { functor, type FunctorLawOpts } from "./functor.js";
