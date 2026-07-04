/**
 * Testing registrar for YOUR_PACKAGE.
 *
 * This file registers property-based test arbitraries and error generators
 * for types in this package, making them available to downstream tests via
 * the corpus testing substrate (fast-check + registry).
 *
 * Add this to your package.json:
 * ```json
 * {
 *   "corpus": {
 *     "testing": "./dist/testing/register.js"
 *   }
 * }
 * ```
 *
 * The vending walker will discover and import this file during test setup,
 * calling register() to populate the registry. This file is side-effect-free
 * on import — only register() performs registration, so consumers can import
 * the branded symbols below for identity without triggering registrations.
 */

import fc from "fast-check";
import { z } from "zod";
import { compose } from "@f0rbit/corpus/testing";
import { failure } from "@f0rbit/corpus/testing";
import { arbitrary } from "@f0rbit/corpus/testing";
import type { ArbBrand } from "@f0rbit/corpus/testing";

// ============================================================================
// Move 1: Declare branded symbols for your domain types
// ============================================================================

/**
 * A branded symbol for YOUR_TYPE. This serves as the stable identity key
 * in the testing registry. Why: identity-bearing domain types (UserId,
 * AuthToken, Money, error discriminators) need stable keys that survive
 * module reloads and don't conflict across the ecosystem. A symbol is
 * unique, unforgeable, and serializable through package boundaries.
 */
export const YOUR_TYPE_BRAND = Symbol(
	"YOUR_PACKAGE/YOUR_TYPE",
) as ArbBrand<YOUR_TYPE>;

/**
 * A branded symbol for YOUR_ERROR. Following the same pattern: this brands
 * your error union so you can register per-variant failure cases below.
 */
export const YOUR_ERROR_BRAND = Symbol(
	"YOUR_PACKAGE/YOUR_ERROR",
) as ArbBrand<YOUR_ERROR>;

// Define your actual types here (or import them from elsewhere).
// These are placeholders.
export type YOUR_TYPE = string & { readonly __brand: "YOUR_TYPE" };

export type YOUR_ERROR =
	| { kind: "variant_one"; message: string }
	| { kind: "variant_two"; code: number };

// ============================================================================
// Move 2: Define a fast-check arbitrary for your type
// ============================================================================

/**
 * A fast-check generator for YOUR_TYPE. This uses compose() to build
 * values by drawing from other arbitraries. The `draw` function lets you
 * compose nested generators; fast-check automatically manages shrinking.
 */
const your_type_arb: fc.Arbitrary<YOUR_TYPE> = fc
	.string({ minLength: 1, maxLength: 100 })
	.map((s) => s as YOUR_TYPE);

// If YOUR_TYPE has more complex structure, use compose() to interleave
// multiple draws:
//
// const your_type_arb = compose((draw) => {
//   const field1 = draw(fc.string());
//   const field2 = draw(fc.integer({ min: 0, max: 100 }));
//   return { field1, field2 } as YOUR_TYPE;
// });

// ============================================================================
// Move 3: Register the arbitrary and error failure cases
// ============================================================================

/**
 * register() is called by the vending walker during test setup. It registers
 * the arbitrary generators and failure cases defined above into the corpus
 * testing registry. Idempotent — calling multiple times is safe (but noisy).
 */
export function register(): void {
	// Register the main arbitrary for YOUR_TYPE.
	arbitrary(YOUR_TYPE_BRAND, your_type_arb);

	// Register error failure cases. For each variant in YOUR_ERROR, call
	// failure() with a compose() generator. Why: error-path laws (property
	// tests that validate error handling) need to provoke specific error
	// variants reliably, not just hope the RNG hits them.

	failure(
		YOUR_ERROR_BRAND,
		"variant_one",
		compose((draw) => ({
			kind: "variant_one" as const,
			message: draw(fc.string({ minLength: 1, maxLength: 200 })),
		})),
	);

	failure(
		YOUR_ERROR_BRAND,
		"variant_two",
		compose((draw) => ({
			kind: "variant_two" as const,
			code: draw(fc.integer({ min: 1, max: 999 })),
		})),
	);
}
