/**
 * @module testing/laws
 * @description Property-based law helpers. Each law is a higher-order assertion
 * that drives a generator + predicate combo through fast-check and surfaces a
 * structured failure when the law is violated.
 *
 * Re-exported from `testing/index.ts` under the `law` namespace —
 * `testing.law.error_path_exhaustive(...)` / `testing.law.provider_equivalence(...)`
 * are the canonical call paths.
 */

export { error_path_exhaustive, DEFAULT_NUM_RUNS } from "./error-path-exhaustive.js";
export { round_trip, DEFAULT_NUM_RUNS as ROUND_TRIP_DEFAULT_NUM_RUNS } from "./round-trip.js";
export { idempotent, DEFAULT_NUM_RUNS as IDEMPOTENT_DEFAULT_NUM_RUNS } from "./idempotent.js";
export { provider_equivalence, equivalence_command } from "./provider-equivalence.js";
