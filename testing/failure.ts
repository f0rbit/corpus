/**
 * @module testing/failure
 * @description Ergonomic surface over the registry's failure-variant primitives.
 *
 * Re-exports {@link failure} and {@link lookup_failure} from the registry with
 * richer JSDoc plus adds {@link list_registered_variants} — the enumeration
 * helper consumers reach for when writing a `provoke` table or a coverage
 * report against a tagged error union.
 *
 * Registration is still explicit — neither this module nor `testing/register`
 * runs on import. The vending auto-loader picks up `"corpus": { "testing" }`
 * package.json hooks and calls `register()` on the first awaited
 * `lookup` / `lookup_failure`; `testing.load_from(...)` loads one explicitly.
 * `list_registered_variants` stays synchronous and does NOT trigger the
 * auto-loader — it enumerates what's registered right now.
 */

import { failure, lookup_failure, list_failure_variants } from "./registry.js";
import type { ArbBrand } from "./types.js";

/**
 * Register an arbitrary for one variant of a tagged error union.
 *
 * Thin re-export of the registry's `failure` primitive — provided here so
 * consumers can `import { failure } from "@f0rbit/corpus/testing"` without
 * reaching into the registry module.
 *
 * @example
 * ```ts
 * import { testing } from "@f0rbit/corpus"
 * import { CORPUS_ERROR_BRAND } from "@f0rbit/corpus/testing"
 *
 * testing.failure(CORPUS_ERROR_BRAND, "not_found", testing.compose((draw) => ({
 *   kind: "not_found" as const,
 *   store_id: draw(testing.fc.string({ minLength: 1 })),
 *   version: draw(testing.fc.string({ minLength: 1 })),
 * })))
 * ```
 */
export { failure, lookup_failure };

/**
 * Enumerate every variant currently registered for `brand`.
 *
 * The return type is `readonly E["kind"][]` — narrower than `string[]`, so
 * downstream call sites get exhaustiveness checks for free when used in
 * mapped-type positions.
 *
 * @example
 * ```ts
 * import { testing } from "@f0rbit/corpus"
 * import { CORPUS_ERROR_BRAND } from "@f0rbit/corpus/testing"
 *
 * const variants = testing.list_registered_variants(CORPUS_ERROR_BRAND)
 * // readonly ('not_found' | 'already_exists' | ... )[]
 * ```
 */
export function list_registered_variants<E extends { kind: string }>(brand: ArbBrand<E>): readonly E["kind"][] {
	return list_failure_variants(brand);
}
