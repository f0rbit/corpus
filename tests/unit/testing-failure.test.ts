import { describe, test, expect, beforeEach } from "bun:test";
import { fake_console_warn } from "../fakes/console.js";
import fc from "fast-check";
import { failure, lookup_failure, list_registered_variants } from "../../testing/failure.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";
import { compose } from "../../testing/compose.js";
import type { ArbBrand } from "../../testing/types";
import type { CorpusError } from "../../types";
import { CORPUS_ERROR_BRAND, register } from "../../testing/register.js";

type DemoError = { kind: "boom"; reason: string } | { kind: "splat"; level: number };

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

const is_hash = (s: string): boolean => /^[a-f0-9]{64}$/.test(s);
const has_ids = (e: { store_id: string; version: string }): boolean => e.store_id.length > 0 && e.version.length > 0;

const shape_checks: { [K in CorpusError["kind"]]: (e: Extract<CorpusError, { kind: K }>) => boolean } = {
	not_found: has_ids,
	already_exists: has_ids,
	concurrent_modification: has_ids,
	storage_error: (e) => e.cause instanceof Error && e.operation.length > 0,
	decode_error: (e) => e.cause instanceof Error,
	encode_error: (e) => e.cause instanceof Error,
	validation_error: (e) => e.cause instanceof Error && e.message.length > 0,
	hash_mismatch: (e) => is_hash(e.expected) && is_hash(e.actual),
	invalid_config: (e) => e.message.length > 0,
	observation_not_found: (e) => e.id.length > 0,
	transaction_aborted: (e) =>
		["returned_err", "threw", "apply_batch_failed"].includes(e.reason) &&
		(e.cause === undefined || e.cause instanceof Error),
	partial_commit: (e) => e.cause instanceof Error && e.ops_failed >= 1 && e.ops_completed >= 0,
};

// The mapped type guarantees each check matches its own kind; the cast only
// erases that correlation for the lookup-by-runtime-kind call site.
const shape_ok = (kind: CorpusError["kind"], e: CorpusError): boolean =>
	e.kind === kind && (shape_checks[kind] as (e: CorpusError) => boolean)(e);

describe("testing/failure module", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	describe("re-exported failure / lookup_failure", () => {
		test("register-then-lookup round-trips per variant", async () => {
			const boom_gen = compose<Extract<DemoError, { kind: "boom" }>>((draw) => ({
				kind: "boom" as const,
				reason: draw(fc.string()),
			}));
			failure(DEMO_ERROR_BRAND, "boom", boom_gen);
			expect(await lookup_failure(DEMO_ERROR_BRAND, "boom")).toBe(boom_gen);
		});

		test("duplicate registration overwrites and warns", async () => {
			const warn = fake_console_warn();
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
				expect(await lookup_failure(DEMO_ERROR_BRAND, "boom")).toBe(second);
				expect(warn.calls.length).toBe(1);
			} finally {
				warn.restore();
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
			expect([...variants].toSorted()).toEqual(["boom", "splat"]);
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
			expect([...variants].toSorted()).toEqual([...ALL_CORPUS_ERROR_VARIANTS].toSorted());
			expect(variants.length).toBe(12);
		});

		test("every kind's generator yields its own kind and a well-formed shape", async () => {
			for (const kind of ALL_CORPUS_ERROR_VARIANTS) {
				const gen = await lookup_failure(CORPUS_ERROR_BRAND, kind);
				if (!gen) throw new Error(`no generator registered for ${kind}`);
				for (const sample of fc.sample(gen, 20)) {
					expect(sample.kind).toBe(kind);
					expect(shape_ok(kind, sample)).toBe(true);
				}
			}
		});
	});

	describe("exhaustive coverage check", () => {
		test("every CorpusError kind is represented in ALL_CORPUS_ERROR_VARIANTS (type-level guard)", () => {
			const exhaustive: Record<CorpusError["kind"], true> = {
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
			expect(Object.keys(exhaustive).toSorted()).toEqual([...ALL_CORPUS_ERROR_VARIANTS].toSorted());
		});
	});
});
