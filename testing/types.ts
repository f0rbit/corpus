/**
 * @module testing/types
 * @description Type-level scaffolding for the corpus testing namespace.
 *
 * Two exports:
 * - {@link ArbBrand} — a branded symbol that carries `T` at the type level
 *   without runtime overhead. Consumers declare a `unique symbol`, cast it
 *   to `ArbBrand<MyType>`, then register an arbitrary against it.
 * - {@link FailureKey} — the union of `kind` discriminants on a tagged error
 *   union. Used by `failure` / `lookup_failure` to address specific variants.
 */

/**
 * A branded symbol that carries `T` at the type level.
 *
 * The phantom `__arb_type` property is structural-only — it never exists at
 * runtime. Its job is to make `ArbBrand<UserId>` and `ArbBrand<OrderId>`
 * incompatible types so the overloaded `arbitrary` / `lookup` functions can
 * infer the right `T` from a given brand.
 *
 * @example
 * ```ts
 * const USER_ID_BRAND = Symbol("UserId") as ArbBrand<UserId>
 * testing.arbitrary(USER_ID_BRAND, fc.uuid())
 * const arb = await testing.lookup(USER_ID_BRAND) // fc.Arbitrary<UserId> | undefined
 * ```
 */
export type ArbBrand<T> = symbol & { readonly __arb_type?: (x: T) => void };

/**
 * The set of discriminant values for a tagged error union.
 *
 * @example
 * ```ts
 * type MyError = { kind: 'not_found' } | { kind: 'denied' }
 * type Keys = FailureKey<MyError> // 'not_found' | 'denied'
 * ```
 */
export type FailureKey<E extends { kind: string }> = E["kind"];
