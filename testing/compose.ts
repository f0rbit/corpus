import type { Arbitrary } from "fast-check";
import * as fc from "fast-check";

/**
 * Type for the draw function that users can call within a compose callback.
 * Synchronously draws a value from an arbitrary.
 */
export type Draw = <T>(arb: Arbitrary<T>) => T;

/**
 * Hypothesis-style composite generator.
 *
 * Allows dependent generation where later draws can depend on earlier draws.
 * The `fn` receives a `draw` callback that can be called with any arbitrary to
 * synchronously extract a value. Shrinking is automatically handled by fast-check.
 *
 * @example
 * ```ts
 * const order_arb = testing.compose((draw) => {
 *   const id = draw(testing.arb(OrderIdSchema));
 *   const item_count = draw(fc.integer({ min: 1, max: 10 }));
 *   const items = draw(
 *     fc.array(testing.arb(ItemSchema), {
 *       minLength: item_count,
 *       maxLength: item_count,
 *     })
 *   );
 *   return { id, items };
 * });
 * ```
 */
export function compose<T>(fn: (draw: Draw) => T): Arbitrary<T> {
	return fc.gen().map((gen_value) => {
		const draw: Draw = <U>(arb: Arbitrary<U>): U => {
			// Use the generator's builder pattern: pass a function that returns the arbitrary
			return gen_value((): Arbitrary<U> => arb);
		};
		return fn(draw);
	});
}
