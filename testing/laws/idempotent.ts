/**
 * @module testing/laws/idempotent
 * @description Idempotent law: op(op(x)) equals op(x) for all generated x.
 *
 * Enforces that applying an operation twice yields the same result as applying
 * it once. Useful for tests of projections, normalizations, canonicalizations,
 * and other naturally idempotent transformations.
 *
 * The operation may be sync or async; the property uses `fc.asyncProperty` and
 * awaits the result unconditionally.
 *
 * Equality defaults to `Bun.deepEquals` (when running under Bun) but requires
 * an explicit `opts.equals` if running outside Bun (Node, workerd). This
 * avoids a top-level Bun reference that would break `import "@f0rbit/corpus"`
 * under Node.
 *
 * Shrinking is disabled (`endOnFailure: true`). The operation may have
 * stateful or path-dependent behavior that breaks under partial shrinks, and
 * generators may be `testing.compose` instances whose `fc.gen()` shrinker does
 * not reliably terminate.
 *
 * @example
 * ```ts
 * const trim_op = (s: string) => s.trim();
 * await testing.law.idempotent(fc.string(), trim_op);
 * ```
 */

import fc from "fast-check";

/**
 * Default number of property runs. Reasonable for most operations.
 */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Assert that `op(op(x))` equals `op(x)` for all generated values.
 *
 * @param arb — Generator of values to test (from fc.* or testing.compose)
 * @param op — Function to test for idempotence; may be sync or async
 * @param opts — Optional `{ equals, numRuns }`
 *   - `equals(a, b)`: Custom equality check; defaults to `Bun.deepEquals` under Bun
 *   - `numRuns`: Property run count; defaults to `DEFAULT_NUM_RUNS`
 *
 * @throws If `op(op(x)) !== op(x)` for any generated `x`, or if no
 * equality function is available and running outside Bun.
 */
export async function idempotent<T>(
	arb: fc.Arbitrary<T>,
	op: (x: T) => T | Promise<T>,
	opts?: {
		equals?: (a: T, b: T) => boolean;
		numRuns?: number;
	},
): Promise<void> {
	const num_runs = opts?.numRuns ?? DEFAULT_NUM_RUNS;
	const equals = opts?.equals ?? get_default_equals<T>();

	await fc.assert(
		fc.asyncProperty(arb, async (x: T) => {
			const once: T = await Promise.resolve(op(x));
			const twice: T = await Promise.resolve(op(once));
			if (!equals(twice, once)) {
				throw new Error(
					`idempotent: op(op(x)) !== op(x)\n  input: ${JSON.stringify(x)}\n  op(x): ${JSON.stringify(once)}\n  op(op(x)): ${JSON.stringify(twice)}`,
				);
			}
		}),
		{ numRuns: num_runs, endOnFailure: true },
	);
}

function get_default_equals<T>(): (a: T, b: T) => boolean {
	if (typeof Bun !== "undefined") {
		return (a: T, b: T) => Bun.deepEquals(a, b);
	}
	throw new Error(
		"idempotent: no equality function provided and Bun is unavailable — pass opts.equals when running outside Bun",
	);
}
