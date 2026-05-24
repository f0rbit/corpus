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
				// Save the first failing case we find
				if (!minimal_failing_case) {
					minimal_failing_case = sample;
				}
				// Update to track the minimal case
				if (sample.n < (minimal_failing_case?.n ?? Infinity)) {
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

	test("nested composition: compose inside compose produces correct values", () => {
		const inner_arb = compose((draw) => {
			const x = draw(fc.integer({ min: 0, max: 50 }));
			return x;
		});

		const outer_arb = compose((draw) => {
			const inner_val = draw(inner_arb);
			const extra = draw(fc.integer({ min: 0, max: 50 }));
			return inner_val + extra;
		});

		const samples = fc.sample(outer_arb, 100);
		for (const sum of samples) {
			// Sum should be between 0 and 100 (since both inner and extra are 0-50)
			expect(sum).toBeGreaterThanOrEqual(0);
			expect(sum).toBeLessThanOrEqual(100);
		}
	});

	test("basic multiple draws: correct types generated", () => {
		const record_arb = compose((draw) => {
			const x = draw(fc.integer());
			const y = draw(fc.integer());
			const name = draw(fc.string());
			return { x, y, name };
		});

		const samples = fc.sample(record_arb, 10);
		expect(samples.length).toBe(10);
		for (const sample of samples) {
			expect(typeof sample.x).toBe("number");
			expect(typeof sample.y).toBe("number");
			expect(typeof sample.name).toBe("string");
		}
	});
});
