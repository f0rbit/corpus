import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";
import type { VersionSetManifest } from "../../index";
import { version_set_store, VersionSetManifestSchema } from "../../index.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import * as testing from "../../testing/index.js";

const fc = testing.fc;

const make_manifest = (pkg: string, overrides?: Partial<VersionSetManifest>): VersionSetManifest => ({
	package: pkg,
	git_sha: "0123456789abcdef0123456789abcdef01234567",
	created_at: "2025-05-01T00:00:00.000Z",
	builds: {
		worker: {
			artifact_ref: "worker-bundles/abc123",
			size_bytes: 12345,
			compatibility_date: "2025-05-01",
		},
	},
	migrations: {
		do_migrations: [],
	},
	env_manifest_ref: "env-manifests/abc123",
	infra_plan_ref: "infra-plans/abc123",
	...overrides,
});

describe("VersionSetManifestSchema", () => {
	it("rejects short git_sha", () => {
		const result = VersionSetManifestSchema.safeParse({
			...make_manifest("pkg-a"),
			git_sha: "abc",
		});
		expect(result.success).toBe(false);
	});

	it('defaults asset version_affinity to "pinned"', () => {
		const parsed = VersionSetManifestSchema.parse({
			...make_manifest("pkg-a"),
			builds: {
				worker: {
					artifact_ref: "worker-bundles/a",
					size_bytes: 1,
					compatibility_date: "2025-01-01",
				},
				assets: { artifact_ref: "assets/a" },
			},
		});
		expect(parsed.builds.assets?.version_affinity).toBe("pinned");
	});

	it("parses a manifest without bundle refs unchanged (no added keys)", () => {
		const manifest = make_manifest("pkg-a");
		const parsed = VersionSetManifestSchema.parse(manifest);
		expect(parsed).toEqual(manifest);
		expect("bundle_manifest_ref" in parsed.builds.worker).toBe(false);
		expect(parsed.builds.assets).toBeUndefined();
	});

	it("defaults do_migrations to []", () => {
		const parsed = VersionSetManifestSchema.parse({
			...make_manifest("pkg-a"),
			migrations: {},
		});
		expect(parsed.migrations.do_migrations).toEqual([]);
	});

	it("parse is idempotent", async () => {
		await testing.law.idempotent(testing.arb(VersionSetManifestSchema), (m) => VersionSetManifestSchema.parse(m), {
			numRuns: 50,
		});
	});
});

describe("version_set_store", () => {
	let version_sets: ReturnType<typeof version_set_store>;

	beforeEach(() => {
		version_sets = version_set_store(create_memory_backend());
	});

	describe("put", () => {
		it("stores a manifest and returns SnapshotMeta", async () => {
			const result = await version_sets.put(make_manifest("anthropic-search"));

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.store_id).toBe("version-sets");
			expect(result.value.version).toBeString();
			expect(result.value.content_hash).toBeString();
			expect(result.value.tags).toContain("pkg:anthropic-search");
		});

		it("partitions data_key by package and content_hash", async () => {
			const a = await version_sets.put(make_manifest("pkg-a"));
			const b = await version_sets.put(make_manifest("pkg-b"));

			expect(a.ok && b.ok).toBe(true);
			if (!a.ok || !b.ok) return;

			expect(a.value.data_key).toBe(`version-sets/pkg-a/${a.value.content_hash}`);
			expect(b.value.data_key).toBe(`version-sets/pkg-b/${b.value.content_hash}`);
		});

		it("dedupes identical manifests via content hash", async () => {
			const manifest = make_manifest("pkg-a");

			const first = await version_sets.put(manifest);
			const second = await version_sets.put(manifest);

			expect(first.ok && second.ok).toBe(true);
			if (!first.ok || !second.ok) return;

			expect(first.value.content_hash).toBe(second.value.content_hash);
			expect(first.value.data_key).toBe(second.value.data_key);
			expect(first.value.version).not.toBe(second.value.version);
		});

		it("round-trips any generated manifest (parsed value is the oracle)", async () => {
			await fc.assert(
				fc.asyncProperty(testing.arb(VersionSetManifestSchema), async (m) => {
					const store = version_set_store(create_memory_backend());

					const put = await store.put(m);
					expect(put.ok).toBe(true);
					if (!put.ok) return;

					const fetched = await store.store.get(put.value.version);
					expect(fetched.ok).toBe(true);
					if (!fetched.ok) return;

					expect(fetched.value.data).toEqual(VersionSetManifestSchema.parse(m));
				}),
				{ numRuns: 50 },
			);
		});

		it("rejects manifests that fail schema validation on decode", async () => {
			const invalid = { ...make_manifest("pkg-a"), git_sha: "too-short" };

			const put = await version_sets.put(invalid);
			expect(put.ok).toBe(true);
			if (!put.ok) return;

			const fetched = await version_sets.store.get(put.value.version);
			expect(fetched.ok).toBe(false);
			if (fetched.ok) return;
			expect(fetched.error.kind).toBe("decode_error");
		});
	});

	describe("lineage", () => {
		it("returns just the starting version when there is no parent", async () => {
			const put = await version_sets.put(make_manifest("pkg-a"));
			expect(put.ok).toBe(true);
			if (!put.ok) return;

			const chain = await version_sets.lineage(put.value.version);
			expect(chain.ok).toBe(true);
			if (!chain.ok) return;

			expect(chain.value).toHaveLength(1);
			expect(chain.value[0]?.version).toBe(put.value.version);
			expect(chain.value[0]?.package).toBe("pkg-a");
			expect(chain.value[0]?.content_hash).toBe(put.value.content_hash);
		});

		it("walks parents back to the root put", async () => {
			const initial = await version_sets.put(make_manifest("pkg-a"));
			expect(initial.ok).toBe(true);
			if (!initial.ok) return;

			const staged = await version_sets.promote(initial.value.version, ["env:staging"]);
			expect(staged.ok).toBe(true);
			if (!staged.ok) return;

			const prod = await version_sets.promote(staged.value.version, ["env:production"]);
			expect(prod.ok).toBe(true);
			if (!prod.ok) return;

			const chain = await version_sets.lineage(prod.value.version);
			expect(chain.ok).toBe(true);
			if (!chain.ok) return;

			expect(chain.value.map((r) => r.version)).toEqual([
				prod.value.version,
				staged.value.version,
				initial.value.version,
			]);
			expect(chain.value.every((r) => r.package === "pkg-a")).toBe(true);
		});

		it("returns not_found for an unknown version", async () => {
			const chain = await version_sets.lineage("does-not-exist");
			expect(chain.ok).toBe(false);
			if (chain.ok) return;
			expect(chain.error.kind).toBe("not_found");
		});

		it("ignores cross-store parents when walking lineage", async () => {
			const initial = await version_sets.put(make_manifest("pkg-a"), {
				parents: [{ store_id: "worker-bundles", version: "wb-1", role: "source" }],
			});
			expect(initial.ok).toBe(true);
			if (!initial.ok) return;

			const chain = await version_sets.lineage(initial.value.version);
			expect(chain.ok).toBe(true);
			if (!chain.ok) return;

			expect(chain.value).toHaveLength(1);
			expect(chain.value[0]?.version).toBe(initial.value.version);
		});
	});

	describe("promote", () => {
		it("creates a new snapshot with new tags referencing the same content", async () => {
			const initial = await version_sets.put(make_manifest("pkg-a"));
			expect(initial.ok).toBe(true);
			if (!initial.ok) return;

			const promoted = await version_sets.promote(initial.value.version, ["env:production", "shape:onebox"]);
			expect(promoted.ok).toBe(true);
			if (!promoted.ok) return;

			expect(promoted.value.version).not.toBe(initial.value.version);
			expect(promoted.value.content_hash).toBe(initial.value.content_hash);
			expect(promoted.value.data_key).toBe(initial.value.data_key);
			expect(promoted.value.tags).toContain("env:production");
			expect(promoted.value.tags).toContain("shape:onebox");
			expect(promoted.value.tags).toContain("pkg:pkg-a");
			expect(promoted.value.parents).toHaveLength(1);
			expect(promoted.value.parents[0]?.store_id).toBe("version-sets");
			expect(promoted.value.parents[0]?.version).toBe(initial.value.version);
		});

		it("returns not_found when source version is missing", async () => {
			const promoted = await version_sets.promote("does-not-exist", ["env:prod"]);
			expect(promoted.ok).toBe(false);
			if (promoted.ok) return;
			expect(promoted.error.kind).toBe("not_found");
		});

		it("preserves underlying manifest content across a promotion chain", async () => {
			const manifest = make_manifest("pkg-a", { grants_ref: "grants/abc" });
			const initial = await version_sets.put(manifest);
			expect(initial.ok).toBe(true);
			if (!initial.ok) return;

			const promoted = await version_sets.promote(initial.value.version, ["env:prod"]);
			expect(promoted.ok).toBe(true);
			if (!promoted.ok) return;

			const fetched = await version_sets.store.get(promoted.value.version);
			expect(fetched.ok).toBe(true);
			if (!fetched.ok) return;
			expect(fetched.value.data).toEqual(manifest);
		});
	});
});

describe("version_set_store on the file backend", () => {
	let file_test_dir = "";

	afterAll(async () => {
		if (file_test_dir) await remove_tmp_dir(file_test_dir);
	});

	it("put then get round-trips a manifest", async () => {
		file_test_dir = await make_tmp_dir("version-set-file");
		const store = version_set_store(create_file_backend({ base_path: file_test_dir }));
		const manifest = make_manifest("pkg-a", { template_ref: "pipeline-templates/abc123def456" });

		const put = await store.put(manifest);
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const fetched = await store.store.get(put.value.version);
		expect(fetched.ok).toBe(true);
		if (!fetched.ok) return;
		expect(fetched.value.data).toEqual(manifest);
	});
});
