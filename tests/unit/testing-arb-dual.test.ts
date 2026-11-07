import { describe, test, expect, beforeEach } from "bun:test";
import fc from "fast-check";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod/v4";
import { arb } from "../../testing/arb.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";

// Both zod subpaths are imported in ONE process to pin the contract that the
// walker dispatches per generation: v3 schemas (no `_zod`) route to the v3
// walker, v4 schemas (`_zod`) to the v4 one, and each generates values that
// pass ITS OWN generation's safeParse.

type Tree = { value: number; children: Tree[] };

const tree_schema3: z3.ZodType<Tree> = z3.lazy(() =>
	z3.object({
		value: z3.number().int().min(0).max(100),
		children: z3.array(tree_schema3).max(2),
	}),
);

const tree_schema4: z4.ZodType<Tree> = z4.lazy(() =>
	z4.object({
		value: z4.number().int().min(0).max(100),
		children: z4.array(tree_schema4).max(2),
	}),
);

// Representative mixed shape: string constraints, enum, array bounds,
// optional, nullable, union, record, default, lazy — all kinds the walker
// claims in both generations.
const mixed_schema3 = z3.object({
	id: z3.string().uuid(),
	role: z3.enum(["admin", "member"]),
	names: z3.array(z3.string().min(1)).max(3),
	age: z3.number().int().min(0).max(130).optional(),
	nickname: z3.string().nullable(),
	tag: z3.union([z3.literal("a"), z3.literal("b")]),
	meta: z3.record(z3.string(), z3.boolean()),
	note: z3.string().default("none"),
	label: z3.lazy(() => z3.string().min(1)),
});

const mixed_schema4 = z4.object({
	id: z4.string().uuid(),
	role: z4.enum(["admin", "member"]),
	names: z4.array(z4.string().min(1)).max(3),
	age: z4.number().int().min(0).max(130).optional(),
	nickname: z4.string().nullable(),
	tag: z4.union([z4.literal("a"), z4.literal("b")]),
	meta: z4.record(z4.string(), z4.boolean()),
	note: z4.string().default("none"),
	label: z4.lazy(() => z4.string().min(1)),
});

describe("testing/arb dual generation", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	test("mixed zod v3 schema generates values its own safeParse accepts", () => {
		fc.assert(
			fc.property(arb(mixed_schema3), (v) => mixed_schema3.safeParse(v).success),
			{ numRuns: 100 },
		);
	});

	test("mixed zod v4 schema generates values its own safeParse accepts", () => {
		fc.assert(
			fc.property(arb(mixed_schema4), (v) => mixed_schema4.safeParse(v).success),
			{ numRuns: 100 },
		);
	});

	test("self-referential recursion terminates for both generations", () => {
		for (const schema of [tree_schema3, tree_schema4]) {
			const samples = fc.sample(arb(schema), { numRuns: 10, seed: 7 });
			for (const s of samples) {
				expect(schema.safeParse(s).success).toBe(true);
			}
		}
	});

	test("both bounds of an integer range are exercised, not just one end", () => {
		// A swapped/dropped bound still satisfies safeParse (a degenerate range is
		// valid), so assert the generated spread itself reaches both halves.
		for (const schema of [z3.number().int().min(10).max(20), z4.number().int().min(10).max(20)]) {
			const samples = fc.sample(arb(schema), { numRuns: 200, seed: 3 });
			expect(samples.every((v) => schema.safeParse(v).success)).toBe(true);
			expect(Math.min(...samples)).toBeLessThan(15);
			expect(Math.max(...samples)).toBeGreaterThan(15);
		}
	});

	test("dispatch is generation-identity based, not class based", () => {
		// The two schemas are structurally identical but built from different
		// class hierarchies; both must walk successfully in the same process.
		const v3_samples = fc.sample(arb(mixed_schema3), { numRuns: 5, seed: 42 });
		const v4_samples = fc.sample(arb(mixed_schema4), { numRuns: 5, seed: 42 });
		expect(v3_samples.length).toBe(5);
		expect(v4_samples.length).toBe(5);
	});
});
