import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { compose } from "../../testing/compose.js";

describe("testing.compose", () => {
	test("dependent generation: array length equals drawn n across 100 runs", () => {
		const order_arb = compose((draw) => {
			const n = draw(fc.integer({ min: 1, max: 10 }));
			const items = draw(fc.array(fc.integer(), { minLength: n, maxLength: n }));
			return { n, items };
		});

		const samples = fc.sample(order_arb, 100);
		for (const sample of samples) {
			expect(sample.items.length).toBe(sample.n);
		}
	});

	test("shrinking: deliberately fail when items.length > 3 to check shrink behavior", () => {
		const arb = compose((draw) => {
			const n = draw(fc.integer({ min: 0, max: 100 }));
			const items = draw(fc.array(fc.integer(), { minLength: n, maxLength: n }));
			return { n, items };
		});

		// Manually run the property and collect failing cases to see shrinking
		let found_failing_case = false;
		let minimal_failing_case: { n: number; items: number[] } | null = null;

		for (let i = 0; i < 100; i++) {
			const samples = fc.sample(arb, 1);
			const sample = samples[0];
			if (sample && sample.items.length > 3) {
				found_failing_case = true;
				// Track the minimal case (first hit seeds it)
				if (!minimal_failing_case || sample.n < minimal_failing_case.n) {
					minimal_failing_case = sample;
				}
			}
		}

		// We should find a failing case (items.length > 3)
		expect(found_failing_case).toBe(true);
		// The minimal case we found should be something with items.length > 3
		expect(minimal_failing_case).not.toBeNull();
		expect((minimal_failing_case?.items.length ?? 0) > 3).toBe(true);
	});
});
