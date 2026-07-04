import { describe, test, expect, beforeEach } from "bun:test";
import fc from "fast-check";
import { error_path_exhaustive } from "../../testing/laws/error-path-exhaustive.js";
import { failure } from "../../testing/failure.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";
import { compose } from "../../testing/compose.js";
import { ok, err } from "../../types.js";
import type { Result } from "../../types.js";
import type { ArbBrand } from "../../testing/types.js";

type DemoError = { kind: "ka" } | { kind: "kb"; reason: string };

const DEMO_BRAND = Symbol("DemoError") as ArbBrand<DemoError>;

type DemoInput = "trigger_ka" | { trigger: "kb"; reason: string };

async function demo(input: DemoInput): Promise<Result<string, DemoError>> {
	if (input === "trigger_ka") return err({ kind: "ka" });
	if (typeof input === "object" && input.trigger === "kb") {
		return err({ kind: "kb", reason: input.reason });
	}
	return ok("happy");
}

const register_ka = (): void => {
	failure(
		DEMO_BRAND,
		"ka",
		compose<Extract<DemoError, { kind: "ka" }>>(() => ({ kind: "ka" as const })),
	);
};

const register_kb = (): void => {
	failure(
		DEMO_BRAND,
		"kb",
		compose<Extract<DemoError, { kind: "kb" }>>((draw) => ({
			kind: "kb" as const,
			reason: draw(fc.string({ minLength: 1, maxLength: 20 })),
		})),
	);
};

// Wrong fn: always returns ka, even when provoked for kb.
const broken = async (_input: DemoInput): Promise<Result<string, DemoError>> => {
	return err({ kind: "ka" });
};

const always_ok = async (_input: DemoInput): Promise<Result<string, DemoError>> => {
	return ok("nope");
};

describe("testing.law.error_path_exhaustive", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	test("happy path — both variants registered, provoke covers both, resolves", async () => {
		register_ka();
		register_kb();

		await error_path_exhaustive(demo, {
			error_brand: DEMO_BRAND,
			provoke: {
				ka: () => ["trigger_ka"],
				kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
			},
			numRuns: 20,
		});
	});

	test("provoke missing a key is a compile-time error", async () => {
		register_ka();
		register_kb();

		await error_path_exhaustive(demo, {
			error_brand: DEMO_BRAND,
			// @ts-expect-error — `kb` missing from provoke; mapped-type enforces exhaustiveness
			provoke: {
				ka: () => ["trigger_ka"],
			},
			only: ["ka"],
			numRuns: 5,
		});
	});

	test("runtime error when a variant is in provoke but has no registered generator", async () => {
		register_ka();
		// deliberately DO NOT register kb

		let thrown: unknown;
		try {
			await error_path_exhaustive(demo, {
				error_brand: DEMO_BRAND,
				provoke: {
					ka: () => ["trigger_ka"],
					kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
				},
				numRuns: 5,
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("error_path_exhaustive");
		expect(message).toContain("no generator registered for variant 'kb'");
		expect(message).toContain("Symbol(DemoError)");
		expect(message).toContain("testing.failure(brand, 'kb', () => ...)");
	});

	test("only filter scopes execution — unregistered variants outside `only` do not trip", async () => {
		register_ka();
		// kb intentionally unregistered

		await error_path_exhaustive(demo, {
			error_brand: DEMO_BRAND,
			provoke: {
				ka: () => ["trigger_ka"],
				kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
			},
			only: ["ka"],
			numRuns: 10,
		});
	});

	test("only filter exercises the named variant — kb-only with kb registered", async () => {
		register_kb();

		await error_path_exhaustive(demo, {
			error_brand: DEMO_BRAND,
			provoke: {
				ka: () => ["trigger_ka"],
				kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
			},
			only: ["kb"],
			numRuns: 10,
		});
	});

	test("fails loudly when fn returns wrong kind for a variant", async () => {
		register_ka();
		register_kb();

		let thrown: unknown;
		try {
			await error_path_exhaustive(broken, {
				error_brand: DEMO_BRAND,
				provoke: {
					ka: () => ["trigger_ka"],
					kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
				},
				only: ["kb"],
				numRuns: 10,
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeDefined();
	});

	test("fails loudly when fn returns ok for an error-path call", async () => {
		register_ka();

		let thrown: unknown;
		try {
			await error_path_exhaustive(always_ok, {
				error_brand: DEMO_BRAND,
				provoke: {
					ka: () => ["trigger_ka"],
					kb: (f) => [{ trigger: "kb" as const, reason: f.reason }],
				},
				only: ["ka"],
				numRuns: 10,
			});
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeDefined();
	});
});
