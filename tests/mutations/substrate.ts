import type { MutationManifest } from "./types.js";

const tests = [
	"tests/unit/testing-arb.test.ts",
	"tests/unit/testing-arb-dual.test.ts",
	"tests/unit/testing-failure.test.ts",
	"tests/unit/testing-compose.test.ts",
	"tests/unit/testing-laws-basic.test.ts",
];

export const manifest = {
	cluster: "substrate",
	old_tests: tests,
	new_tests: tests,
	// Not listed (unkillable): `list_failure_variants` builds a fresh array via Array.from(map.keys()), so there is no
	// internal array to leak; the "fresh array" test is kept as a contract example only.
	mutations: [
		{
			id: "substrate/arb-v4-ignores-min-length",
			file: "testing/arb-v4.ts",
			find: "const opts: { minLength?: number; maxLength?: number } = {};\n\tif (min?.minimum !== undefined) opts.minLength = min.minimum;",
			replace: "const opts: { minLength?: number; maxLength?: number } = {};\n\tvoid min;",
			guards: "v4 string min_length bound reaches the generated strings",
		},
		{
			id: "substrate/arb-v4-ignores-number-format-int",
			file: "testing/arb-v4.ts",
			find: "INT_NUMBER_FORMATS.has(c.format)",
			replace: "INT_NUMBER_FORMATS.has(c.format) && false",
			guards: "v4 z.number().int() generates integers, not doubles",
		},
		{
			id: "substrate/arb-v3-tuple-one-short",
			file: "testing/arb-v3.ts",
			find: "return fc.tuple(...arbs);",
			replace: "return fc.tuple(...arbs.slice(0, -1));",
			guards: "v3 tuple walker emits every element",
		},
		{
			id: "substrate/register-partial-commit-zero-ops-failed",
			file: "testing/register.ts",
			find: "ops_failed: draw(fc.integer({ min: 1, max: 100 })),",
			replace: "ops_failed: draw(fc.constant(0)),",
			guards: "partial_commit failures always have at least one failed op",
		},
		{
			id: "substrate/register-hash-mismatch-not-hex",
			file: "testing/register.ts",
			find: "actual: draw(hex_hash),",
			replace: 'actual: "not-a-hash",',
			guards: "hash_mismatch expected/actual are 64-char hex",
		},
		{
			id: "substrate/round-trip-comparison-always-true",
			file: "testing/laws/round-trip.ts",
			find: "if (!equals(decoded, x)) {",
			replace: "if (false && !equals(decoded, x)) {",
			guards: "round_trip fails when decode(encode(x)) differs from x",
		},
		{
			id: "substrate/functor-identity-check-skipped",
			file: "testing/laws/functor.ts",
			find: "const is_equal = await Promise.resolve(opts.equals(x, mapped));",
			replace: "const is_equal = true;",
			guards: "functor law catches a map that breaks identity",
		},
		{
			id: "substrate/functor-composition-check-skipped",
			file: "testing/laws/functor.ts",
			find: "const is_equal = await Promise.resolve(opts.equals(left, right));",
			replace: "const is_equal = true;",
			guards: "functor law catches a map that breaks composition",
		},
		{
			id: "substrate/idempotent-op-applied-once",
			file: "testing/laws/idempotent.ts",
			find: "const twice: T = await Promise.resolve(op(once));",
			replace: "const twice: T = once;",
			guards: "idempotent law applies the op a second time",
		},
		{
			id: "substrate/default-equals-always-true",
			file: "testing/laws/equality.ts",
			find: "return (a: T, b: T) => Bun.deepEquals(a, b);",
			replace: "return () => true;",
			guards: "default equality distinguishes unequal values",
		},
	],
} satisfies MutationManifest;
