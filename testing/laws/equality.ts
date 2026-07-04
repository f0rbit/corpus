/**
 * @module testing/laws/equality
 * @description Shared default-equality resolution for law helpers.
 *
 * Laws default to `Bun.deepEquals` when running under Bun. Outside Bun (Node,
 * workerd) there is no ambient deep-equality, so the resolver throws an
 * actionable error naming the law — callers pass `opts.equals` explicitly.
 * Resolution is lazy (only runs when the caller omitted `equals`) and guards
 * `typeof Bun`, so no top-level Bun reference leaks into Node imports of the
 * barrel.
 */

export function default_equals<T>(law: string): (a: T, b: T) => boolean {
	if (typeof Bun !== "undefined") {
		return (a: T, b: T) => Bun.deepEquals(a, b);
	}
	throw new Error(
		`${law}: no equality function provided and Bun is unavailable — pass opts.equals when running outside Bun`,
	);
}
