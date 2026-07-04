/**
 * @module testing/laws/round-trip
 * @description Round-trip law: decode(encode(x)) equals x for all generated x.
 *
 * Enforces serialization idempotence. Useful for codecs, encoders, data
 * transformations, and any function pair satisfying a round-trip contract.
 *
 * Both `encode` and `decode` may be sync or async; the property uses
 * `fc.asyncProperty` and awaits both unconditionally.
 *
 * Equality defaults to `Bun.deepEquals` (when running under Bun) but requires
 * an explicit `opts.equals` if running outside Bun (Node, workerd). This
 * avoids a top-level Bun reference that would break `import "@f0rbit/corpus"`
 * under Node.
 *
 * Shrinking is disabled (`endOnFailure: true`). Reasons: the encode/decode
 * pair may rely on subtle interactions that break under partial shrinks, and
 * generators may be `testing.compose` instances whose `fc.gen()` shrinker does
 * not reliably terminate.
 *
 * @example
 * ```ts
 * const text_codec = {
 *   encode: (x: string) => new TextEncoder().encode(x),
 *   decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
 * };
 * await testing.law.round_trip(fc.string(), text_codec.encode, text_codec.decode);
 * ```
 */

import fc from "fast-check";

/**
 * Default number of property runs. Reasonable for most encode/decode pairs.
 */
export const DEFAULT_NUM_RUNS = 100;

/**
 * Assert that `decode(encode(x))` equals `x` for all generated values.
 *
 * @param arb — Generator of values to round-trip (from fc.* or testing.compose)
 * @param encode — Function to transform a value; may be sync or async
 * @param decode — Function to reverse the transform; may be sync or async
 * @param opts — Optional `{ equals, numRuns }`
 *   - `equals(a, b)`: Custom equality check; defaults to `Bun.deepEquals` under Bun
 *   - `numRuns`: Property run count; defaults to `DEFAULT_NUM_RUNS`
 *
 * @throws If `decode(encode(x)) !== x` for any generated `x`, or if no
 * equality function is available and running outside Bun.
 */
export async function round_trip<T>(
	arb: fc.Arbitrary<T>,
	encode: (x: T) => Uint8Array | Promise<Uint8Array>,
	decode: (bytes: Uint8Array) => T | Promise<T>,
	opts?: {
		equals?: (a: T, b: T) => boolean;
		numRuns?: number;
	},
): Promise<void> {
	const num_runs = opts?.numRuns ?? DEFAULT_NUM_RUNS;
	const equals = opts?.equals ?? get_default_equals<T>();

	await fc.assert(
		fc.asyncProperty(arb, async (x: T) => {
			const encoded: Uint8Array = await Promise.resolve(encode(x));
			const decoded: T = await Promise.resolve(decode(encoded));
			if (!equals(decoded, x)) {
				throw new Error(
					`round_trip: decode(encode(x)) !== x\n  input: ${JSON.stringify(x)}\n  decoded: ${JSON.stringify(decoded)}`,
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
		"round_trip: no equality function provided and Bun is unavailable — pass opts.equals when running outside Bun",
	);
}
