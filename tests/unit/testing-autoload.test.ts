import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { arb } from "../../testing/arb.js";
import { lookup, __reset_registry_for_tests } from "../../testing/registry.js";
import { load_from, __set_auto_load_cwd_for_tests } from "../../testing/vending/auto-load.js";
import { HAPPY_MARKER_BRAND, calls as self_calls } from "../fixtures/vending/happy/self-register.js";
import { calls as dep_calls } from "../fixtures/vending/happy/node_modules/dep-with-registrar/register.js";
import { fake_console_warn } from "../fakes/console.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vending");
const HAPPY = join(FIXTURES, "happy");

describe("testing/vending/auto-load", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
		__set_auto_load_cwd_for_tests(HAPPY);
	});

	afterAll(() => {
		__set_auto_load_cwd_for_tests(null);
		__reset_registry_for_tests();
	});

	test("first lookup triggers the walker and makes vended arbitraries visible", async () => {
		const self_before = self_calls.count;
		const dep_before = dep_calls.count;

		const marker = await lookup(HAPPY_MARKER_BRAND);

		expect(marker).toBeDefined();
		expect(self_calls.count).toBe(self_before + 1);
		expect(dep_calls.count).toBe(dep_before + 1);
	});

	test("second lookup does not re-walk", async () => {
		await lookup(HAPPY_MARKER_BRAND);
		const self_after_first = self_calls.count;

		await lookup(HAPPY_MARKER_BRAND);
		await lookup(HAPPY_MARKER_BRAND);

		expect(self_calls.count).toBe(self_after_first);
	});

	test("concurrent first lookups share a single walk", async () => {
		const self_before = self_calls.count;

		await Promise.all([lookup(HAPPY_MARKER_BRAND), lookup(HAPPY_MARKER_BRAND), lookup(HAPPY_MARKER_BRAND)]);

		expect(self_calls.count).toBe(self_before + 1);
	});

	test("__reset_registry_for_tests clears the promise — next lookup re-walks", async () => {
		await lookup(HAPPY_MARKER_BRAND);
		const self_after_first = self_calls.count;

		__reset_registry_for_tests();
		expect(await lookup(HAPPY_MARKER_BRAND)).toBeDefined();

		expect(self_calls.count).toBe(self_after_first + 1);
	});

	test("load_from loads exactly one package's registrar, without walking its deps", async () => {
		const self_before = self_calls.count;
		const dep_before = dep_calls.count;

		const outcome = await load_from(HAPPY);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.loaded).toEqual(["vending-happy"]);
		expect(outcome.value.failed).toEqual([]);
		expect(self_calls.count).toBe(self_before + 1);
		expect(dep_calls.count).toBe(dep_before);
	});

	test("load_from on a package without a registrar entry → no_registrar", async () => {
		const outcome = await load_from(join(FIXTURES, "missing-registrar"));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.kind).toBe("no_registrar");
	});

	test("discovery failure warns with an actionable message and never throws", async () => {
		__set_auto_load_cwd_for_tests(join(FIXTURES, "malformed"));
		const warn = fake_console_warn();
		try {
			expect(await lookup(HAPPY_MARKER_BRAND)).toBeUndefined();
			expect(warn.calls.length).toBe(1);
			expect(String(warn.calls[0]?.[0])).toContain("load_from");
		} finally {
			warn.restore();
		}
	});

	test("broken dependency registrar warns per package but does not block lookups", async () => {
		__set_auto_load_cwd_for_tests(join(FIXTURES, "missing-registrar"));
		const warn = fake_console_warn();
		try {
			expect(await lookup(HAPPY_MARKER_BRAND)).toBeUndefined();
			expect(warn.calls.length).toBe(1);
			expect(String(warn.calls[0]?.[0])).toContain("broken-registrar");
		} finally {
			warn.restore();
		}
	});

	test("arb(schema) does not trigger auto-load", () => {
		const self_before = self_calls.count;

		const gen = arb(z.object({ id: z.string(), n: z.number() }));

		expect(gen).toBeDefined();
		expect(self_calls.count).toBe(self_before);
	});
});
