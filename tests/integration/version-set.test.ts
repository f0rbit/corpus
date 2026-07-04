import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Backend, VersionSetManifest } from "../../index";
import { version_set_store, VersionSetManifestSchema } from "../../index";
import { create_memory_backend } from "../../backend/memory";
import { create_file_backend } from "../../backend/file";

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

type BackendFactory = () => Backend | Promise<Backend>;
type CleanupFn = () => void | Promise<void>;

function run_version_set_tests(name: string, factory: BackendFactory, cleanup?: CleanupFn) {
	describe(`${name} - version_set_store`, () => {
		let backend: Backend;
		let version_sets: ReturnType<typeof version_set_store>;

		beforeEach(async () => {
			if (cleanup) await cleanup();
			backend = await factory();
			version_sets = version_set_store(backend);
		});

		describe("put", () => {
			it("stores a manifest and returns SnapshotMeta", async () => {
				const manifest = make_manifest("anthropic-search");

				const result = await version_sets.put(manifest);

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
				// distinct snapshots though — separate versions
				expect(first.value.version).not.toBe(second.value.version);
			});

			it("preserves manifest content on roundtrip via underlying store", async () => {
				const manifest = make_manifest("pkg-a", {
					builds: {
						worker: {
							artifact_ref: "worker-bundles/xyz",
							size_bytes: 9000,
							compatibility_date: "2024-12-01",
						},
						assets: {
							artifact_ref: "assets/xyz",
							version_affinity: "pinned",
						},
					},
					migrations: {
						d1_plan_ref: "d1-plans/m1",
						do_migrations: [{ class_name: "Sessions", tag: "v1", kind: "new_sqlite_classes" }],
					},
					grants_ref: "grants/g1",
				});

				const put = await version_sets.put(manifest);
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				const fetched = await version_sets.store.get(put.value.version);
				expect(fetched.ok).toBe(true);
				if (!fetched.ok) return;

				expect(fetched.value.data).toEqual(manifest);
			});

			it("round-trips manifest with template_ref set", async () => {
				const manifest = make_manifest("pkg-a", {
					template_ref: "pipeline-templates/abc123def456",
				});

				const put = await version_sets.put(manifest);
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				const fetched = await version_sets.store.get(put.value.version);
				expect(fetched.ok).toBe(true);
				if (!fetched.ok) return;

				expect(fetched.value.data.template_ref).toBe("pipeline-templates/abc123def456");
				expect(fetched.value.data).toEqual(manifest);
			});

			it("round-trips manifest without template_ref (optional field)", async () => {
				const manifest = make_manifest("pkg-a");

				const put = await version_sets.put(manifest);
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				const fetched = await version_sets.store.get(put.value.version);
				expect(fetched.ok).toBe(true);
				if (!fetched.ok) return;

				expect(fetched.value.data.template_ref).toBeUndefined();
			});

			it("rejects manifests that fail schema validation on decode", async () => {
				const invalid = { ...make_manifest("pkg-a"), git_sha: "too-short" } as VersionSetManifest;

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
				// put with an unrelated cross-store parent
				const initial = await version_sets.put(make_manifest("pkg-a"), {
					parents: [{ store_id: "worker-bundles", version: "wb-1", role: "source" }],
				});
				expect(initial.ok).toBe(true);
				if (!initial.ok) return;

				const chain = await version_sets.lineage(initial.value.version);
				expect(chain.ok).toBe(true);
				if (!chain.ok) return;

				// only the self-store parent walk — cross-store parent ignored
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
				// dedup: same content -> same content_hash + data_key
				expect(promoted.value.content_hash).toBe(initial.value.content_hash);
				expect(promoted.value.data_key).toBe(initial.value.data_key);
				// new tags applied + pkg tag preserved
				expect(promoted.value.tags).toContain("env:production");
				expect(promoted.value.tags).toContain("shape:onebox");
				expect(promoted.value.tags).toContain("pkg:pkg-a");
				// parent points back at source for lineage
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

		describe("schema", () => {
			it("VersionSetManifestSchema accepts the fixture", () => {
				const result = VersionSetManifestSchema.safeParse(make_manifest("pkg-a"));
				expect(result.success).toBe(true);
			});

			it("VersionSetManifestSchema rejects short git_sha", () => {
				const result = VersionSetManifestSchema.safeParse({
					...make_manifest("pkg-a"),
					git_sha: "abc",
				});
				expect(result.success).toBe(false);
			});

			it('VersionSetManifestSchema defaults asset version_affinity to "pinned"', () => {
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

			it("VersionSetManifestSchema defaults do_migrations to []", () => {
				const parsed = VersionSetManifestSchema.parse({
					...make_manifest("pkg-a"),
					migrations: {},
				});
				expect(parsed.migrations.do_migrations).toEqual([]);
			});
		});
	});
}

run_version_set_tests("MemoryBackend", () => create_memory_backend());

const fileTestDir = join(tmpdir(), "corpus-version-set-test-file");
run_version_set_tests(
	"FileBackend",
	async () => {
		await rm(fileTestDir, { recursive: true, force: true });
		await mkdir(fileTestDir, { recursive: true });
		return create_file_backend({ base_path: fileTestDir });
	},
	async () => {
		await rm(fileTestDir, { recursive: true, force: true });
	},
);

afterAll(async () => {
	await rm(fileTestDir, { recursive: true, force: true });
});
