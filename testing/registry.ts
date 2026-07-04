/**
 * @module testing/registry
 * @description Hybrid registry for fast-check arbitraries.
 *
 * Two key spaces share a single public API surface via overloads:
 *
 * 1. **Branded symbol** — `arbitrary(BRAND, gen)` / `lookup(BRAND)`. Backed by a
 *    `Map<symbol, fc.Arbitrary<unknown>>`. Used for identity-bearing domain
 *    types (`UserId`, `OrderId`, `CorpusError`) where a single canonical
 *    arbitrary is registered once and reused everywhere.
 * 2. **Zod schema instance** — `arbitrary(schema, gen)` / `lookup(schema)`.
 *    Backed by a `WeakMap<z.ZodType, fc.Arbitrary<unknown>>` so registered
 *    schemas remain garbage-collectable. Used for ad-hoc schemas declared in a
 *    test file without a long-lived brand.
 *
 * Variant-level failure registrations (`failure(BRAND, "not_found", ...)`) live
 * in a nested map keyed by `[error_brand, variant_kind]`.
 *
 * Internally the maps store `fc.Arbitrary<unknown>`. The overloaded public
 * signatures narrow the result back to the consumer's expected type via a
 * single `as` cast at the boundary — this is the documented escape hatch and
 * the only place in the registry where an unchecked cast lives.
 */

import type { Arbitrary } from "fast-check";
import type { z } from "zod";
import type { ArbBrand } from "./types.js";

let brand_arbs = new Map<symbol, Arbitrary<unknown>>();
let schema_arbs = new WeakMap<z.ZodType, Arbitrary<unknown>>();
let failures = new Map<symbol, Map<string, Arbitrary<unknown>>>();

/**
 * Register an arbitrary against a branded symbol.
 *
 * @example
 * ```ts
 * const USER_ID_BRAND = Symbol("UserId") as ArbBrand<UserId>
 * testing.arbitrary(USER_ID_BRAND, fc.uuid())
 * ```
 */
export function arbitrary<T>(key: ArbBrand<T>, gen: Arbitrary<T>): void;
/**
 * Register an arbitrary against a Zod schema instance.
 *
 * @example
 * ```ts
 * const UserSchema = z.object({ id: z.string(), name: z.string() })
 * testing.arbitrary(UserSchema, fc.record({ id: fc.uuid(), name: fc.string() }))
 * ```
 */
export function arbitrary<S extends z.ZodType>(schema: S, gen: Arbitrary<z.infer<S>>): void;
export function arbitrary(key: symbol | z.ZodType, gen: Arbitrary<unknown>): void {
	if (typeof key === "symbol") {
		if (brand_arbs.has(key)) {
			console.warn(`testing.arbitrary: brand ${String(key)} already registered — overwriting.`);
		}
		brand_arbs.set(key, gen);
		return;
	}
	if (schema_arbs.has(key)) {
		console.warn(`testing.arbitrary: schema instance already registered — overwriting.`);
	}
	schema_arbs.set(key, gen);
}

/**
 * Look up the arbitrary registered against a branded symbol.
 *
 * @returns the registered arbitrary, or `undefined` if none is registered.
 */
export function lookup<T>(key: ArbBrand<T>): Arbitrary<T> | undefined;
/**
 * Look up the arbitrary registered against a Zod schema instance.
 *
 * @returns the registered arbitrary, or `undefined` if none is registered.
 */
export function lookup<S extends z.ZodType>(schema: S): Arbitrary<z.infer<S>> | undefined;
export function lookup(key: symbol | z.ZodType): Arbitrary<unknown> | undefined {
	if (typeof key === "symbol") return brand_arbs.get(key);
	return schema_arbs.get(key);
}

/**
 * Register an arbitrary for a specific variant of a tagged error union.
 *
 * `brand` identifies the error type; `variant` selects the discriminant
 * (`error.kind`) being targeted.
 *
 * @example
 * ```ts
 * const CORPUS_ERROR_BRAND = Symbol("CorpusError") as ArbBrand<CorpusError>
 * testing.failure(CORPUS_ERROR_BRAND, "not_found", fc.record({
 *   kind: fc.constant("not_found" as const),
 *   store_id: fc.string(),
 *   version: fc.string(),
 * }))
 * ```
 */
export function failure<E extends { kind: string }, K extends E["kind"]>(
	brand: ArbBrand<E>,
	variant: K,
	gen: Arbitrary<Extract<E, { kind: K }>>
): void {
	let by_variant = failures.get(brand);
	if (!by_variant) {
		by_variant = new Map<string, Arbitrary<unknown>>();
		failures.set(brand, by_variant);
	}
	if (by_variant.has(variant)) {
		console.warn(`testing.failure: ${String(brand)}/${variant} already registered — overwriting.`);
	}
	by_variant.set(variant, gen);
}

/**
 * Look up the arbitrary registered for a specific variant of a tagged error
 * union.
 *
 * @returns the registered arbitrary, or `undefined` if none is registered for
 * the given `[brand, variant]` pair.
 */
export function lookup_failure<E extends { kind: string }>(
	brand: ArbBrand<E>,
	variant: E["kind"]
): Arbitrary<E> | undefined {
	const by_variant = failures.get(brand);
	if (!by_variant) return undefined;
	return by_variant.get(variant) as Arbitrary<E> | undefined;
}

/**
 * Enumerate every variant `kind` currently registered against `brand`.
 *
 * Returns the variants in insertion order. The result is a fresh array — safe
 * for the consumer to mutate. The narrow return type `readonly E["kind"][]`
 * is preserved so callers don't get back a plain `string[]`.
 *
 * @returns an array of variant discriminants; empty if no failures registered.
 */
export function list_failure_variants<E extends { kind: string }>(
	brand: ArbBrand<E>
): readonly E["kind"][] {
	const by_variant = failures.get(brand);
	if (!by_variant) return [];
	return Array.from(by_variant.keys()) as E["kind"][];
}

/**
 * Reset all three registries to fresh empty maps. Test-only helper — the
 * leading `__` is the convention for "do not call from production code".
 */
export function __reset_registry_for_tests(): void {
	brand_arbs = new Map<symbol, Arbitrary<unknown>>();
	schema_arbs = new WeakMap<z.ZodType, Arbitrary<unknown>>();
	failures = new Map<symbol, Map<string, Arbitrary<unknown>>>();
}
