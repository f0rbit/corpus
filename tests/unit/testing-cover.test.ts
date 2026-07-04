import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { cover_property, CoverageError, DEFAULT_NUM_RUNS } from "../../testing/cover.js";

const run_once = async (): Promise<number> => {
	fc.configureGlobal({ seed: 0xc0ffee, randomType: "xorshift128plus" });
	try {
		await cover_property(fc.integer({ min: 0, max: 9 }), (_n) => true, {
			// 100% requirement on a 10% predicate is guaranteed to fail
			// and surface the stats.
			labels: [{ name: "is_zero", min_percent: 100, matches: (n) => n === 0 }],
			numRuns: 200,
		});
		return -1;
	} catch (e) {
		if (e instanceof CoverageError) {
			const stat = e.stats.find((s) => s.name === "is_zero");
			return stat?.hits ?? -1;
		}
		throw e;
	}
};

describe("testing.cover", () => {
	test("property passes + all labels met: resolves without throwing", async () => {
		await cover_property(fc.integer({ min: -100, max: 100 }), (_n) => true, {
			labels: [
				{ name: "negative", min_percent: 20, matches: (n) => n < 0 },
				{ name: "non_negative", min_percent: 20, matches: (n) => n >= 0 },
			],
			numRuns: 200,
		});
	});

	test("property passes but one label below minimum: throws CoverageError", async () => {
		// `n === 0` is essentially never produced by fc.integer over the full
		// signed-32-bit range, so requiring 50% coverage forces the shortfall.
		const promise = cover_property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (_n) => true, {
			labels: [
				{ name: "any", min_percent: 0, matches: (_n) => true },
				{ name: "exactly_zero", min_percent: 50, matches: (n) => n === 0 },
			],
			numRuns: 100,
		});
		await expect(promise).rejects.toBeInstanceOf(CoverageError);
	});

	test("property fails: fast-check counterexample surfaces, coverage check is suppressed", async () => {
		// Predicate fails for any sample > 5. fc.assert throws a Property failed
		// error containing the counterexample — and crucially the error is NOT a
		// CoverageError, even though the unmet "all" label would have triggered
		// one if the property had passed.
		let thrown: unknown;
		try {
			await cover_property(fc.integer({ min: 0, max: 10 }), (n) => n <= 5, {
				labels: [{ name: "impossible", min_percent: 100, matches: (n) => n === -1 }],
				numRuns: 200,
			});
		} catch (e) {
			thrown = e;
		}
		expect(thrown).toBeDefined();
		expect(thrown).not.toBeInstanceOf(CoverageError);
		expect(String(thrown)).toMatch(/Property failed/);
	});

	test("CoverageError message lists ALL labels — met ones flagged OK, unmet flagged FAIL", async () => {
		try {
			await cover_property(fc.integer({ min: 0, max: 99 }), (_n) => true, {
				labels: [
					{ name: "always_hit", min_percent: 90, matches: (_n) => true },
					{ name: "never_hit", min_percent: 50, matches: (_n) => false },
				],
				numRuns: 200,
			});
			throw new Error("expected CoverageError to be thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(CoverageError);
			const err = e as CoverageError;
			expect(err.message).toMatch(/\[OK {2}\] always_hit/);
			expect(err.message).toMatch(/\[FAIL\] never_hit/);
			expect(err.stats).toHaveLength(2);
			const always = err.stats.find((s) => s.name === "always_hit");
			const never = err.stats.find((s) => s.name === "never_hit");
			expect(always?.met).toBe(true);
			expect(never?.met).toBe(false);
			expect(always?.hits).toBe(always?.total);
			expect(never?.hits).toBe(0);
		}
	});

	test("deterministic seed: hit counts stable across runs", async () => {
		// fc.assert reads its seed from the global config when none is passed
		// directly. Pin both runs to the same seed and assert the stats line up.
		const a = await run_once();
		const b = await run_once();
		fc.configureGlobal({});
		expect(a).toBeGreaterThanOrEqual(0);
		expect(a).toBe(b);
	});

	test("hit counts equal numRuns: tally happens once per sample inside the predicate wrapper", async () => {
		try {
			await cover_property(fc.integer({ min: 0, max: 99 }), (_n) => true, {
				labels: [{ name: "all", min_percent: 200, matches: (_n) => true }],
				numRuns: 137,
			});
			throw new Error("expected shortfall");
		} catch (e) {
			expect(e).toBeInstanceOf(CoverageError);
			const stat = (e as CoverageError).stats[0];
			expect(stat?.total).toBe(137);
			expect(stat?.hits).toBe(137);
		}
	});

	test("default numRuns: 200 samples when opts.numRuns is omitted", async () => {
		try {
			await cover_property(fc.integer({ min: 0, max: 99 }), (_n) => true, {
				labels: [{ name: "all", min_percent: 200, matches: (_n) => true }],
			});
			throw new Error("expected shortfall");
		} catch (e) {
			expect(e).toBeInstanceOf(CoverageError);
			const stat = (e as CoverageError).stats[0];
			expect(stat?.total).toBe(DEFAULT_NUM_RUNS);
			expect(DEFAULT_NUM_RUNS).toBe(200);
		}
	});
});
