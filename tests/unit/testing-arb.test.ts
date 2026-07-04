import { describe, test, expect, beforeEach } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import { arb } from "../../testing/arb.js";
import { arbitrary, __reset_registry_for_tests } from "../../testing/registry.js";
import { VersionSetManifestSchema } from "../../version-set.js";

describe("testing/arb", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	describe("primitives", () => {
		test("string with min/max length honours bounds", () => {
			const a = arb(z.string().min(3).max(7));
			fc.assert(
				fc.property(a, (v) => v.length >= 3 && v.length <= 7),
				{ numRuns: 100 },
			);
		});

		test("string with exact .length()", () => {
			const a = arb(z.string().length(10));
			fc.assert(
				fc.property(a, (v) => v.length === 10),
				{ numRuns: 100 },
			);
		});

		test("string.uuid() produces parseable uuids", () => {
			const schema = z.string().uuid();
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("string.email() produces parseable emails", () => {
			const schema = z.string().email();
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("string.regex() honours the pattern", () => {
			const schema = z.string().regex(/^[a-z]{3,5}$/);
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("string.datetime() produces parseable ISO timestamps", () => {
			const schema = z.string().datetime();
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("integer with bounds", () => {
			const a = arb(z.number().int().min(0).max(100));
			fc.assert(
				fc.property(a, (v) => Number.isInteger(v) && v >= 0 && v <= 100),
				{ numRuns: 100 },
			);
		});

		test("float (not int) produces real numbers", () => {
			const schema = z.number();
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => typeof v === "number" && !Number.isNaN(v)),
				{ numRuns: 100 },
			);
		});

		test("boolean", () => {
			const a = arb(z.boolean());
			fc.assert(
				fc.property(a, (v) => typeof v === "boolean"),
				{ numRuns: 50 },
			);
		});

		test("date", () => {
			const a = arb(z.date());
			fc.assert(
				fc.property(a, (v) => v instanceof Date),
				{ numRuns: 50 },
			);
		});

		test("bigint", () => {
			const a = arb(z.bigint());
			fc.assert(
				fc.property(a, (v) => typeof v === "bigint"),
				{ numRuns: 50 },
			);
		});

		test("literal pinned to the documented value", () => {
			const a = arb(z.literal("yes"));
			fc.assert(
				fc.property(a, (v) => v === "yes"),
				{ numRuns: 20 },
			);
		});

		test("enum picks from values", () => {
			const a = arb(z.enum(["red", "green", "blue"]));
			fc.assert(
				fc.property(a, (v) => v === "red" || v === "green" || v === "blue"),
				{ numRuns: 50 },
			);
		});

		test("nativeEnum picks from values", () => {
			enum Color {
				Red = "red",
				Green = "green",
			}
			const a = arb(z.nativeEnum(Color));
			fc.assert(
				fc.property(a, (v) => v === Color.Red || v === Color.Green),
				{ numRuns: 50 },
			);
		});
	});

	describe("composites", () => {
		test("object recurses into children", () => {
			const schema = z.object({
				id: z.string().uuid(),
				count: z.number().int().min(0).max(10),
				active: z.boolean(),
			});
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("nested objects recurse correctly", () => {
			const schema = z.object({
				outer: z.object({
					inner: z.object({
						leaf: z.string(),
					}),
				}),
			});
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => typeof v.outer.inner.leaf === "string"),
				{ numRuns: 50 },
			);
		});

		test("array honours min/max length", () => {
			const a = arb(z.array(z.number()).min(2).max(5));
			fc.assert(
				fc.property(a, (v) => v.length >= 2 && v.length <= 5),
				{ numRuns: 100 },
			);
		});

		test("tuple produces fixed-shape arrays", () => {
			const a = arb(z.tuple([z.string(), z.number(), z.boolean()]));
			fc.assert(
				fc.property(a, ([s, n, b]) => typeof s === "string" && typeof n === "number" && typeof b === "boolean"),
				{ numRuns: 50 },
			);
		});

		test("union picks all branches across enough samples", () => {
			const schema = z.union([z.literal("a"), z.literal("b"), z.literal("c")]);
			const a = arb(schema);
			const seen = new Set<string>();
			fc.assert(
				fc.property(a, (v) => {
					seen.add(v);
					return v === "a" || v === "b" || v === "c";
				}),
				{ numRuns: 200 },
			);
			expect(seen.size).toBe(3);
		});

		test("discriminated union round-trips", () => {
			const schema = z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("ping"), at: z.number() }),
				z.object({ kind: z.literal("pong"), code: z.string() }),
			]);
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 100 },
			);
		});

		test("optional emits both defined and undefined", () => {
			const a = arb(z.string().optional());
			const seen = { defined: false, undef: false };
			fc.assert(
				fc.property(a, (v) => {
					if (v === undefined) seen.undef = true;
					else seen.defined = true;
					return v === undefined || typeof v === "string";
				}),
				{ numRuns: 200 },
			);
			expect(seen.defined).toBe(true);
			expect(seen.undef).toBe(true);
		});

		test("nullable emits both defined and null", () => {
			const a = arb(z.string().nullable());
			const seen = { defined: false, nul: false };
			fc.assert(
				fc.property(a, (v) => {
					if (v === null) seen.nul = true;
					else seen.defined = true;
					return v === null || typeof v === "string";
				}),
				{ numRuns: 200 },
			);
			expect(seen.defined).toBe(true);
			expect(seen.nul).toBe(true);
		});

		test("branded passes through to inner type", () => {
			const schema = z.string().uuid().brand<"UserId">();
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => typeof v === "string" && schema.safeParse(v).success),
				{ numRuns: 50 },
			);
		});

		test("default unwraps to inner type", () => {
			const schema = z.string().default("fallback");
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => typeof v === "string"),
				{ numRuns: 50 },
			);
		});

		test("record produces a string-keyed object", () => {
			const a = arb(z.record(z.string(), z.number()));
			fc.assert(
				fc.property(a, (v) => {
					for (const k of Object.keys(v)) {
						if (typeof k !== "string") return false;
						if (typeof v[k] !== "number") return false;
					}
					return true;
				}),
				{ numRuns: 50 },
			);
		});

		test("intersection merges both shapes", () => {
			const schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => schema.safeParse(v).success),
				{ numRuns: 50 },
			);
		});
	});

	describe("registry short-circuit", () => {
		test("registered schema bypasses walker", () => {
			const schema = z.object({ ignored: z.string() });
			arbitrary(schema, fc.constant({ ignored: "registered" }));
			const a = arb(schema);
			fc.assert(
				fc.property(a, (v) => v.ignored === "registered"),
				{ numRuns: 20 },
			);
		});

		test("registered child schema short-circuits at recursion site", () => {
			const inner = z.string();
			arbitrary(inner, fc.constant("PINNED"));
			const outer = z.object({ value: inner });
			fc.assert(
				fc.property(arb(outer), (v) => v.value === "PINNED"),
				{ numRuns: 20 },
			);
		});
	});

	describe("lazy / recursion", () => {
		test("self-referential lazy schema terminates without unbounded recursion", () => {
			// Two-layer self-reference. The inner array has max=2 children; combined
			// with fast-check's depthSize bias inside fc.letrec/fc.oneof, average
			// generated depth stays small. We don't claim absolute bounds — just
			// that generation + parsing don't blow up.
			type Tree = { value: number; children: Tree[] };
			const tree_schema: z.ZodType<Tree> = z.lazy(() =>
				z.object({
					value: z.number().int().min(0).max(100),
					children: z.array(tree_schema).max(2),
				}),
			);
			// fc.sample asserts only that we can produce a small batch without
			// stack-overflowing. The schema validates structure.
			const a = arb(tree_schema);
			const samples = fc.sample(a, { numRuns: 10, seed: 7 });
			for (const s of samples) {
				expect(tree_schema.safeParse(s).success).toBe(true);
			}
		});
	});

	describe("unsupported schema kinds", () => {
		test("ZodEffects throws with a message naming the kind and pointing at the escape hatch", () => {
			const schema = z.string().refine((s) => s.length > 0);
			expect(() => arb(schema)).toThrow(/ZodEffects/);
			expect(() => arb(schema)).toThrow(/testing\.arbitrary/);
		});
	});

	describe("real corpus schema round-trip", () => {
		test("VersionSetManifestSchema generates valid manifests across 100 runs", () => {
			const a = arb(VersionSetManifestSchema);
			fc.assert(
				fc.property(a, (m) => VersionSetManifestSchema.safeParse(m).success),
				{ numRuns: 100 },
			);
		});
	});
});
