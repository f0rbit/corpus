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
 *
 * `lookup` and `lookup_failure` are async: the first call triggers the
 * vending auto-loader (`./vending/auto-load.js`), which discovers and loads
 * registrars declared via `"corpus": { "testing": ... }` package.json keys.
 * Registration (`arbitrary` / `failure`) stays synchronous, as do the
 * `_sync` accessors used by `arb()` — deriving an arbitrary from a schema
 * must not spring filesystem walks on a synchronous call path.
 */

import type { Arbitrary } from "fast-check";
import type { z } from "zod";
import type { ArbBrand } from "./types.js";
import { __reset_auto_load_for_tests, ensure_loaded } from "./vending/auto-load.js";

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
 * Async since 0.7.0: the first lookup per registry state triggers the vending
 * auto-loader, so arbitraries registered by dependencies' registrars are
 * visible with zero manual wiring.
 *
 * @example
 * ```ts
 * const user_arb = await testing.lookup(USER_ID_BRAND)
 * ```
 *
 * @returns the registered arbitrary, or `undefined` if none is registered.
 */
export function lookup<T>(key: ArbBrand<T>): Promise<Arbitrary<T> | undefined>;
/**
 * Look up the arbitrary registered against a Zod schema instance.
 *
 * @returns the registered arbitrary, or `undefined` if none is registered.
 */
export function lookup<S extends z.ZodType>(schema: S): Promise<Arbitrary<z.infer<S>> | undefined>;
export async function lookup(key: symbol | z.ZodType): Promise<Arbitrary<unknown> | undefined> {
	await ensure_loaded();
	return lookup_now(key);
}

/**
 * Synchronous lookup that does NOT trigger the vending auto-loader. Internal —
 * used by `arb()`'s schema walker, which is a synchronous API and must not
 * spring filesystem walks mid-derivation. Only sees registrations made in
 * this process so far (manual calls, or a prior awaited `lookup`/`load_from`).
 */
export function lookup_sync<T>(key: ArbBrand<T>): Arbitrary<T> | undefined;
export function lookup_sync<S extends z.ZodType>(schema: S): Arbitrary<z.infer<S>> | undefined;
export function lookup_sync(key: symbol | z.ZodType): Arbitrary<unknown> | undefined {
	return lookup_now(key);
}

function lookup_now(key: symbol | z.ZodType): Arbitrary<unknown> | undefined {
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
 * Async since 0.7.0: the first lookup per registry state triggers the vending
 * auto-loader (see {@link lookup}).
 *
 * @returns the registered arbitrary, or `undefined` if none is registered for
 * the given `[brand, variant]` pair.
 */
export async function lookup_failure<E extends { kind: string }>(
	brand: ArbBrand<E>,
	variant: E["kind"]
): Promise<Arbitrary<E> | undefined> {
	await ensure_loaded();
	return lookup_failure_sync(brand, variant);
}

/**
 * Synchronous failure lookup that does NOT trigger the vending auto-loader.
 * Internal counterpart of {@link lookup_sync}.
 */
export function lookup_failure_sync<E extends { kind: string }>(
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
 * Reset all three registries to fresh empty maps AND clear the auto-load
 * promise, so the next `lookup` / `lookup_failure` re-walks vended
 * registrars. Test-only helper — the leading `__` is the convention for
 * "do not call from production code".
 */
export function __reset_registry_for_tests(): void {
	brand_arbs = new Map<symbol, Arbitrary<unknown>>();
	schema_arbs = new WeakMap<z.ZodType, Arbitrary<unknown>>();
	failures = new Map<symbol, Map<string, Arbitrary<unknown>>>();
	__reset_auto_load_for_tests();
}
