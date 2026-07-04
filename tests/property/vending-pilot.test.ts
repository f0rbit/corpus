import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import fc from "fast-check";
import { lookup, lookup_failure, load_from, __reset_registry_for_tests } from "../../testing/index.js";
// Symbol-only import — NOT a direct registrar call. Evaluating the fixture
// module just defines the brand symbols (registration lives inside its
// register(), which only the walker machinery invokes via load_from below).
// Importing the symbols here is what carries brand identity across the
// fixture/test boundary: both sides must hold the SAME symbol instance.
import { AUTH_TOKEN_BRAND, VAULT_ERROR_BRAND, auth_token_schema } from "../fixtures/example-consumer/register.js";

// The fixture isn't a real npm install, so the auto-walk from the repo's cwd
// can't discover it — the pilot drives the same walker machinery explicitly
// via load_from(fixture_dir), exactly the escape hatch a monorepo sibling
// would use.
const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "example-consumer");

describe("property: vending pilot — external package contributes arbitraries", () => {
	beforeAll(async () => {
		__reset_registry_for_tests();
		const outcome = await load_from(FIXTURE_DIR);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.loaded).toEqual(["example-consumer"]);
		expect(outcome.value.failed).toEqual([]);
	});

	afterAll(() => {
		__reset_registry_for_tests();
	});

	test("lookup(AUTH_TOKEN_BRAND) resolves the vended arbitrary", async () => {
		const token_arb = await lookup(AUTH_TOKEN_BRAND);
		expect(token_arb).toBeDefined();
	});

	test("generated tokens match the fixture's declared shape (200 runs)", async () => {
		const token_arb = await lookup(AUTH_TOKEN_BRAND);
		expect(token_arb).toBeDefined();
		if (!token_arb) return;

		fc.assert(
			fc.property(token_arb, (token) => auth_token_schema.safeParse(token).success),
			{ numRuns: 200 },
		);
	});

	test("lookup_failure finds the vended rate_limited variant", async () => {
		const rate_limited_arb = await lookup_failure(VAULT_ERROR_BRAND, "rate_limited");
		expect(rate_limited_arb).toBeDefined();
		if (!rate_limited_arb) return;

		const samples = fc.sample(rate_limited_arb, 20);
		for (const sample of samples) {
			expect(sample.kind).toBe("rate_limited");
			if (sample.kind !== "rate_limited") continue;
			expect(sample.retry_after_ms).toBeGreaterThanOrEqual(0);
			expect(sample.retry_after_ms).toBeLessThanOrEqual(60_000);
		}
	});
});
