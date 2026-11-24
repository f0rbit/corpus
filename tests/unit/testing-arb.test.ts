import { describe, test, expect, beforeEach } from "bun:test";
import { z } from "zod";
import * as testing from "../../testing/index.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";
import type { SchemaLike } from "../../types.js";
import { VersionSetManifestSchema } from "../../version-set.js";

enum Color {
	Red = "red",
	Green = "green",
}

type Tree = { value: number; children: Tree[] };

// Bounds and formats live in the schema itself: a generated value that breaks
// one fails the schema's own safeParse, so no per-row bespoke assertion is needed.
const rows = [
	["string min/max", z.string().min(3).max(7)],
	["string exact length", z.string().length(10)],
	["string uuid", z.string().uuid()],
	["string email", z.string().email()],
	["string regex", z.string().regex(/^[a-z]{3,5}$/)],
	["string datetime", z.string().datetime()],
	["integer bounds", z.number().int().min(0).max(100)],
	["float", z.number()],
	["boolean", z.boolean()],
	["bigint", z.bigint()],
	["literal", z.literal("yes")],
	["enum", z.enum(["red", "green", "blue"])],
	["nativeEnum", z.nativeEnum(Color)],
	["object", z.object({ id: z.string().uuid(), count: z.number().int().min(0).max(10), active: z.boolean() })],
	["nested objects", z.object({ outer: z.object({ inner: z.object({ leaf: z.string() }) }) })],
	["array min/max", z.array(z.number()).min(2).max(5)],
	["tuple", z.tuple([z.string(), z.number(), z.boolean()])],
	["union", z.union([z.literal("a"), z.literal("b"), z.literal("c")])],
	[
		"discriminated union",
		z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("ping"), at: z.number() }),
			z.object({ kind: z.literal("pong"), code: z.string() }),
		]),
	],
	["optional", z.string().optional()],
	["nullable", z.string().nullable()],
	["branded", z.string().uuid().brand<"UserId">()],
	["default", z.string().default("fallback")],
	["record", z.record(z.string(), z.number())],
	["intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))],
] as const;

const assert_generates = (label: string, schema: SchemaLike): void => {
	testing.fc.assert(
		testing.fc.property(testing.arb(schema), (v) => {
			if (!schema.safeParse(v).success) throw new Error(`${label}: generated a value its own schema rejects`);
		}),
		{ numRuns: 100 },
	);
};

const fc_assert_instance_of_date = (): void => {
	testing.fc.assert(
		testing.fc.property(testing.arb(z.date()), (v) => v instanceof Date),
		{ numRuns: 100 },
	);
};

describe("testing/arb", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	test("every primitive and composite kind generates values its own schema accepts", () => {
		for (const [label, schema] of rows) assert_generates(label, schema);
	});

	// fc.date() may emit Invalid Date, which z.date() rejects, so only the type is asserted.
	test("date generates Date instances", () => {
		fc_assert_instance_of_date();
	});

	describe("branch reach", () => {
		test("union reaches every branch", async () => {
			await testing.cover(testing.arb(z.union([z.literal("a"), z.literal("b"), z.literal("c")])), () => true, {
				labels: ["a", "b", "c"].map((name) => ({ name, min_percent: 10, matches: (v: string) => v === name })),
			});
		});

		test("optional emits both defined and undefined", async () => {
			await testing.cover(testing.arb(z.string().optional()), () => true, {
				labels: [
					{ name: "undefined", min_percent: 5, matches: (v) => v === undefined },
					{ name: "defined", min_percent: 5, matches: (v) => typeof v === "string" },
				],
			});
		});

		test("nullable emits both null and defined", async () => {
			await testing.cover(testing.arb(z.string().nullable()), () => true, {
				labels: [
					{ name: "null", min_percent: 5, matches: (v) => v === null },
					{ name: "defined", min_percent: 5, matches: (v) => typeof v === "string" },
				],
			});
		});
	});

	describe("registry short-circuit", () => {
		test("registered schema bypasses walker", () => {
			const schema = z.object({ ignored: z.string() });
			testing.arbitrary(schema, testing.fc.constant({ ignored: "registered" }));
			testing.fc.assert(
				testing.fc.property(testing.arb(schema), (v) => v.ignored === "registered"),
				{ numRuns: 20 },
			);
		});

		test("registered child schema short-circuits at recursion site", () => {
			const inner = z.string();
			testing.arbitrary(inner, testing.fc.constant("PINNED"));
			const outer = z.object({ value: inner });
			testing.fc.assert(
				testing.fc.property(testing.arb(outer), (v) => v.value === "PINNED"),
				{ numRuns: 20 },
			);
		});
	});

	describe("lazy / recursion", () => {
		test("self-referential lazy schema terminates without unbounded recursion", () => {
			const tree_schema: z.ZodType<Tree> = z.lazy(() =>
				z.object({
					value: z.number().int().min(0).max(100),
					children: z.array(tree_schema).max(2),
				}),
			);
			const samples = testing.fc.sample(testing.arb(tree_schema), { numRuns: 10, seed: 7 });
			for (const s of samples) {
				expect(tree_schema.safeParse(s).success).toBe(true);
			}
		});
	});

	describe("unsupported schema kinds", () => {
		// The suite runs under both zod generations (tests import the root zod):
		// v3 wraps .refine() in ZodEffects; v4 attaches a `custom` check and the
		// v4 walker names `refinement` for it. Each generation asserts its own
		// kind name — same actionability contract, generation-specific wording.
		const is_zod4 = "_zod" in z.string();
		const kind_pattern = is_zod4 ? /refinement/ : /ZodEffects/;
		test("refined schemas throw with a message naming the kind and pointing at the escape hatch", () => {
			const schema = z.string().refine((s) => s.length > 0);
			expect(() => testing.arb(schema)).toThrow(kind_pattern);
			expect(() => testing.arb(schema)).toThrow(/testing\.arbitrary/);
		});
	});

	describe("real corpus schema round-trip", () => {
		test("VersionSetManifestSchema generates valid manifests across 100 runs", () => {
			testing.fc.assert(
				testing.fc.property(
					testing.arb(VersionSetManifestSchema),
					(m) => VersionSetManifestSchema.safeParse(m).success,
				),
				{ numRuns: 100 },
			);
		});
	});
});
