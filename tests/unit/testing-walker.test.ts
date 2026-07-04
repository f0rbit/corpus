import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { discover_registrars, load_registrars } from "../../testing/vending/walker.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";
import { calls as self_calls } from "../fixtures/vending/happy/self-register.js";
import { calls as dep_calls } from "../fixtures/vending/happy/node_modules/dep-with-registrar/register.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "vending");

describe("testing/vending/walker", () => {
	describe("discover_registrars", () => {
		test("discovers self + direct-dep registrars, skipping deps without the key", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "happy") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;

			const packages = discovered.value.map((s) => s.package);
			expect(packages).toEqual(["vending-happy", "dep-with-registrar"]);
			expect(discovered.value[0]?.origin).toBe("self");
			expect(discovered.value[0]?.registrar.endsWith("/self-register.ts")).toBe(true);
			expect(discovered.value[1]?.origin).toBe("dependency");
			expect(packages).not.toContain("dep-without-key");
			expect(packages).not.toContain("fast-check");
		});

		test("does not walk transitive dependencies", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "happy") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;
			expect(discovered.value.map((s) => s.package)).not.toContain("transitive-registrar");
		});

		test("malformed cwd package.json → package_json_malformed", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "malformed") });
			expect(discovered.ok).toBe(false);
			if (discovered.ok) return;
			expect(discovered.error.kind).toBe("package_json_malformed");
		});

		test("missing cwd package.json → package_json_unreadable", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "does-not-exist") });
			expect(discovered.ok).toBe(false);
			if (discovered.ok) return;
			expect(discovered.error.kind).toBe("package_json_unreadable");
		});

		test("self registrar pointing at a missing file is skipped silently", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "self-missing") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;
			expect(discovered.value).toEqual([]);
		});

		test("cwd package named @f0rbit/corpus is skipped (dev-checkout guard)", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "dev-checkout") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;
			expect(discovered.value).toEqual([]);
		});
	});

	describe("load_registrars", () => {
		test("imports each spec and invokes its register() export", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "happy") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;

			const self_before = self_calls.count;
			const dep_before = dep_calls.count;
			const outcome = await load_registrars(discovered.value);
			if (!outcome.ok) return;

			expect(outcome.value.loaded).toEqual(["vending-happy", "dep-with-registrar"]);
			expect(outcome.value.failed).toEqual([]);
			expect(self_calls.count).toBe(self_before + 1);
			expect(dep_calls.count).toBe(dep_before + 1);
			__reset_registry_for_tests();
		});

		test("missing registrar file → failed entry, never throws", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "missing-registrar") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;
			expect(discovered.value.map((s) => s.package)).toEqual(["broken-registrar"]);

			const outcome = await load_registrars(discovered.value);
			if (!outcome.ok) return;
			expect(outcome.value.loaded).toEqual([]);
			expect(outcome.value.failed).toHaveLength(1);
			expect(outcome.value.failed[0]?.package).toBe("broken-registrar");
			expect(outcome.value.failed[0]?.cause).toBeInstanceOf(Error);
		});

		test("registrar whose register() throws → failed entry with the thrown cause", async () => {
			const discovered = await discover_registrars({ cwd: join(FIXTURES, "throwing") });
			expect(discovered.ok).toBe(true);
			if (!discovered.ok) return;

			const outcome = await load_registrars(discovered.value);
			if (!outcome.ok) return;
			expect(outcome.value.loaded).toEqual([]);
			expect(outcome.value.failed[0]?.package).toBe("throwing-registrar");
			expect(outcome.value.failed[0]?.cause.message).toContain("exploded on purpose");
		});
	});
});
