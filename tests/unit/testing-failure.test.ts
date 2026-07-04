import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import fc from "fast-check";
import {
	failure,
	lookup_failure,
	list_registered_variants,
} from "../../testing/failure";
import { __reset_registry_for_tests } from "../../testing/registry";
import { compose } from "../../testing/compose";
import type { ArbBrand } from "../../testing/types";
import type { CorpusError } from "../../types";
import { CORPUS_ERROR_BRAND, register } from "../../testing/register";

type DemoError =
	| { kind: "boom"; reason: string }
	| { kind: "splat"; level: number };

const DEMO_ERROR_BRAND = Symbol("DemoError") as ArbBrand<DemoError>;

const ALL_CORPUS_ERROR_VARIANTS: readonly CorpusError["kind"][] = [
	"not_found",
	"already_exists",
	"storage_error",
	"decode_error",
	"encode_error",
	"hash_mismatch",
	"invalid_config",
	"validation_error",
	"observation_not_found",
	"transaction_aborted",
	"partial_commit",
	"concurrent_modification",
];

describe("testing/failure module", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	describe("re-exported failure / lookup_failure", () => {
		test("register-then-lookup round-trips per variant", () => {
			const boom_gen = compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
				kind: "boom" as const,
				reason: draw(fc.string()),
			}));
			failure(DEMO_ERROR_BRAND, "boom", boom_gen);
			expect(lookup_failure(DEMO_ERROR_BRAND, "boom")).toBe(boom_gen);
		});

		test("duplicate registration overwrites and warns", () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const first = compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
					kind: "boom" as const,
					reason: draw(fc.constant("first")),
				}));
				const second = compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
					kind: "boom" as const,
					reason: draw(fc.constant("second")),
				}));
				failure(DEMO_ERROR_BRAND, "boom", first);
				failure(DEMO_ERROR_BRAND, "boom", second);
				expect(lookup_failure(DEMO_ERROR_BRAND, "boom")).toBe(second);
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("list_registered_variants", () => {
		test("empty when no variants registered", () => {
			expect(list_registered_variants(DEMO_ERROR_BRAND)).toEqual([]);
		});

		test("returns every registered variant", () => {
			failure(
				DEMO_ERROR_BRAND,
				"boom",
				compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
					kind: "boom" as const,
					reason: draw(fc.string()),
				})),
			);
			failure(
				DEMO_ERROR_BRAND,
				"splat",
				compose<Extract<DemoError, { kind: "splat" }>>((draw) => ({
					kind: "splat" as const,
					level: draw(fc.integer()),
				})),
			);
			const variants = list_registered_variants(DEMO_ERROR_BRAND);
			expect([...variants].sort()).toEqual(["boom", "splat"]);
		});

		test("result is a fresh array — mutations do not affect the registry", () => {
			failure(
				DEMO_ERROR_BRAND,
				"boom",
				compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
					kind: "boom" as const,
					reason: draw(fc.string()),
				})),
			);
			const first = list_registered_variants(DEMO_ERROR_BRAND);
			(first as DemoError["kind"][]).length = 0;
			const second = list_registered_variants(DEMO_ERROR_BRAND);
			expect(second).toEqual(["boom"]);
		});
	});

	describe("CorpusError registrations via register()", () => {
		beforeEach(() => {
			register();
		});

		test("list_registered_variants returns all 12 CorpusError variants", () => {
			const variants = list_registered_variants(CORPUS_ERROR_BRAND);
			expect([...variants].sort()).toEqual([...ALL_CORPUS_ERROR_VARIANTS].sort());
			expect(variants.length).toBe(12);
		});

		for (const kind of ALL_CORPUS_ERROR_VARIANTS) {
			test(`${kind} generator is registered and produces values with matching kind`, () => {
				const gen = lookup_failure(CORPUS_ERROR_BRAND, kind);
				expect(gen).toBeDefined();
				if (!gen) return;
				const samples = fc.sample(gen, 10);
				for (const sample of samples) {
					expect(sample.kind).toBe(kind);
				}
			});
		}

		test("storage_error cause is a real Error instance", () => {
			const gen = lookup_failure(CORPUS_ERROR_BRAND, "storage_error");
			expect(gen).toBeDefined();
			if (!gen) return;
			const samples = fc.sample(gen, 10);
			for (const sample of samples) {
				if (sample.kind !== "storage_error") throw new Error("unreachable");
				expect(sample.cause).toBeInstanceOf(Error);
				expect(typeof sample.operation).toBe("string");
			}
		});

		test("decode_error / encode_error / validation_error / partial_commit causes are Error instances", () => {
			const kinds = ["decode_error", "encode_error", "validation_error", "partial_commit"] as const;
			for (const kind of kinds) {
				const gen = lookup_failure(CORPUS_ERROR_BRAND, kind);
				expect(gen).toBeDefined();
				if (!gen) continue;
				const samples = fc.sample(gen, 5);
				for (const sample of samples) {
					if (sample.kind !== kind) throw new Error("unreachable");
					expect(sample.cause).toBeInstanceOf(Error);
				}
			}
		});

		test("transaction_aborted reason is one of the allowed literals", () => {
			const gen = lookup_failure(CORPUS_ERROR_BRAND, "transaction_aborted");
			expect(gen).toBeDefined();
			if (!gen) return;
			const allowed = new Set(["returned_err", "threw", "apply_batch_failed"]);
			const samples = fc.sample(gen, 20);
			for (const sample of samples) {
				if (sample.kind !== "transaction_aborted") throw new Error("unreachable");
				expect(allowed.has(sample.reason)).toBe(true);
				if (sample.cause !== undefined) {
					expect(sample.cause).toBeInstanceOf(Error);
				}
			}
		});

		test("hash_mismatch expected/actual are 64-char hex strings", () => {
			const gen = lookup_failure(CORPUS_ERROR_BRAND, "hash_mismatch");
			expect(gen).toBeDefined();
			if (!gen) return;
			const samples = fc.sample(gen, 10);
			for (const sample of samples) {
				if (sample.kind !== "hash_mismatch") throw new Error("unreachable");
				expect(sample.expected).toMatch(/^[a-f0-9]{64}$/);
				expect(sample.actual).toMatch(/^[a-f0-9]{64}$/);
			}
		});

		test("not_found / already_exists / concurrent_modification carry non-empty store_id + version", () => {
			const kinds = ["not_found", "already_exists", "concurrent_modification"] as const;
			for (const kind of kinds) {
				const gen = lookup_failure(CORPUS_ERROR_BRAND, kind);
				expect(gen).toBeDefined();
				if (!gen) continue;
				const samples = fc.sample(gen, 5);
				for (const sample of samples) {
					if (sample.kind !== kind) throw new Error("unreachable");
					expect(sample.store_id.length).toBeGreaterThan(0);
					expect(sample.version.length).toBeGreaterThan(0);
				}
			}
		});

		test("partial_commit ops_failed is at least 1 (otherwise it wouldn't be 'partial')", () => {
			const gen = lookup_failure(CORPUS_ERROR_BRAND, "partial_commit");
			expect(gen).toBeDefined();
			if (!gen) return;
			const samples = fc.sample(gen, 10);
			for (const sample of samples) {
				if (sample.kind !== "partial_commit") throw new Error("unreachable");
				expect(sample.ops_failed).toBeGreaterThanOrEqual(1);
				expect(sample.ops_completed).toBeGreaterThanOrEqual(0);
			}
		});
	});

	describe("exhaustive coverage check", () => {
		test("every CorpusError kind is represented in ALL_CORPUS_ERROR_VARIANTS (type-level guard)", () => {
			const _exhaustive: Record<CorpusError["kind"], true> = {
				not_found: true,
				already_exists: true,
				storage_error: true,
				decode_error: true,
				encode_error: true,
				hash_mismatch: true,
				invalid_config: true,
				validation_error: true,
				observation_not_found: true,
				transaction_aborted: true,
				partial_commit: true,
				concurrent_modification: true,
			};
			expect(Object.keys(_exhaustive).sort()).toEqual([...ALL_CORPUS_ERROR_VARIANTS].sort());
		});
	});
});
