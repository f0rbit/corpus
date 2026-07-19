/**
 * Integration tests for `copy()` (copy.ts, plan task 3.1) against real
 * backends: file → file, and remote-fake → file using the phase-2 D1-HTTP /
 * S3 fakes (same fakes as tests/integration/remote-backend.test.ts).
 *
 * Seeded data keys stay in the default `${store_id}/${content_hash}` shape.
 * The file backend's `data_path` (backend/file.ts:64) sanitises `/` → `_`
 * when mapping a data_key to a file name, so an exotic custom `data_key_fn`
 * layout COULD alias two distinct source keys onto one destination file —
 * `copy()` preserves `data_key` verbatim (see copy.ts module doc), so this
 * is a property of the destination backend, not of `copy()` itself. Not
 * exercised here on purpose; the default layout never collides.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { copy, type CopyProgressEvent } from "../../copy.js";
import { create_file_backend } from "../../backend/file.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_remote_backend } from "../../backend/remote.js";
import { corpus_snapshots } from "../../schema.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";
import { err, type Backend, type MetadataClient, type SnapshotMeta } from "../../types.js";

function make_meta(
	overrides: Partial<SnapshotMeta> & Pick<SnapshotMeta, "store_id" | "version" | "data_key">,
): SnapshotMeta {
	return {
		parents: [],
		created_at: new Date("2024-06-01T00:00:00.000Z"),
		content_hash: `hash-${overrides.version}`,
		content_type: "application/octet-stream",
		size_bytes: 0,
		...overrides,
	};
}

async function seed(backend: Backend, meta: SnapshotMeta, bytes: Uint8Array): Promise<void> {
	const data_put = await backend.data.put(meta.data_key, bytes);
	if (!data_put.ok) throw new Error(`seed: data.put failed (${data_put.error.kind})`);
	const meta_put = await backend.metadata.put({ ...meta, size_bytes: bytes.byteLength });
	if (!meta_put.ok) throw new Error(`seed: metadata.put failed (${meta_put.error.kind})`);
}

async function collect(backend: Backend, store_id: string): Promise<SnapshotMeta[]> {
	const out: SnapshotMeta[] = [];
	for await (const meta of backend.metadata.list(store_id)) out.push(meta);
	return out.toSorted((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

async function bytes_at(backend: Backend, data_key: string): Promise<Uint8Array> {
	const got = await backend.data.get(data_key);
	if (!got.ok) throw new Error(`expected data at ${data_key} (${got.error.kind})`);
	return got.value.bytes();
}

describe("copy() — integration", () => {
	const SRC_DIR = join(import.meta.dir, ".test-copy-src");
	const DEST_DIR = join(import.meta.dir, ".test-copy-dest");

	beforeEach(async () => {
		await rm(SRC_DIR, { recursive: true, force: true });
		await rm(DEST_DIR, { recursive: true, force: true });
		await mkdir(SRC_DIR, { recursive: true });
		await mkdir(DEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(SRC_DIR, { recursive: true, force: true });
		await rm(DEST_DIR, { recursive: true, force: true });
	});

	it("clones a store's versions + data verbatim, file → file", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest = create_file_backend({ base_path: DEST_DIR });

		const bytes_a = new TextEncoder().encode("hello-a");
		const bytes_b = new TextEncoder().encode("hello-b");
		await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes_a);
		await seed(source, make_meta({ store_id: "docs", version: "v2", data_key: "docs/hash-v2" }), bytes_b);

		const result = await copy(source, dest);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toEqual({
			stores: ["docs"],
			versions_copied: 2,
			versions_skipped: 0,
			data_objects_copied: 2,
			data_objects_skipped: 0,
			bytes_copied: bytes_a.byteLength + bytes_b.byteLength,
			dry_run: false,
		});

		const source_metas = await collect(source, "docs");
		const dest_metas = await collect(dest, "docs");
		expect(dest_metas).toEqual(source_metas);

		expect(await bytes_at(dest, "docs/hash-v1")).toEqual(bytes_a);
		expect(await bytes_at(dest, "docs/hash-v2")).toEqual(bytes_b);
	});

	it("second run is a no-op — hash-skip idempotency", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest = create_file_backend({ base_path: DEST_DIR });

		await seed(
			source,
			make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }),
			new TextEncoder().encode("a"),
		);
		await seed(
			source,
			make_meta({ store_id: "docs", version: "v2", data_key: "docs/hash-v2" }),
			new TextEncoder().encode("b"),
		);

		const first = await copy(source, dest);
		expect(first.ok).toBe(true);

		const second = await copy(source, dest);
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// Both versions are skipped at the metadata level, so dest.data is never
		// even queried the second time around — data_objects_skipped stays 0
		// (distinct from data_objects_copied/skipped, which only count versions
		// whose metadata was a miss at dest; see copy.ts's copy_version).
		expect(second.value).toEqual({
			stores: ["docs"],
			versions_copied: 0,
			versions_skipped: 2,
			data_objects_copied: 0,
			data_objects_skipped: 0,
			bytes_copied: 0,
			dry_run: false,
		});
	});

	it("filters by store id and by tags", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });

		await seed(
			source,
			make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1", tags: ["published"] }),
			new TextEncoder().encode("a"),
		);
		await seed(
			source,
			make_meta({ store_id: "docs", version: "v2", data_key: "docs/hash-v2", tags: ["draft"] }),
			new TextEncoder().encode("b"),
		);
		await seed(
			source,
			make_meta({ store_id: "notes", version: "v1", data_key: "notes/hash-v1" }),
			new TextEncoder().encode("c"),
		);

		const dest = create_file_backend({ base_path: DEST_DIR });
		const store_filtered = await copy(source, dest, { stores: ["docs"] });
		expect(store_filtered.ok).toBe(true);
		if (!store_filtered.ok) return;
		expect(store_filtered.value.stores).toEqual(["docs"]);
		expect(store_filtered.value.versions_copied).toBe(2);
		expect(await collect(dest, "notes")).toHaveLength(0);

		await rm(DEST_DIR, { recursive: true, force: true });
		const dest2 = create_file_backend({ base_path: DEST_DIR });
		const tag_filtered = await copy(source, dest2, { stores: ["docs"], tags: ["published"] });
		expect(tag_filtered.ok).toBe(true);
		if (!tag_filtered.ok) return;
		expect(tag_filtered.value.versions_copied).toBe(1);
		const docs_at_dest2 = await collect(dest2, "docs");
		expect(docs_at_dest2.map((m) => m.version)).toEqual(["v1"]);
	});

	it("dry-run reports what would happen without writing to dest", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest = create_file_backend({ base_path: DEST_DIR });

		await seed(
			source,
			make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }),
			new TextEncoder().encode("a"),
		);

		const result = await copy(source, dest, { dry_run: true });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).toEqual({
			stores: ["docs"],
			versions_copied: 1,
			versions_skipped: 0,
			data_objects_copied: 0,
			data_objects_skipped: 0,
			bytes_copied: 0,
			dry_run: true,
		});

		expect(await collect(dest, "docs")).toHaveLength(0);
		expect(await dest.data.exists("docs/hash-v1")).toBe(false);
	});

	it("dedups data transfer across versions sharing a data_key", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest = create_file_backend({ base_path: DEST_DIR });

		const shared_bytes = new TextEncoder().encode("shared-content");
		const shared_key = "docs/shared-hash";
		await seed(
			source,
			make_meta({ store_id: "docs", version: "v1", data_key: shared_key, content_hash: "shared-hash" }),
			shared_bytes,
		);
		await seed(
			source,
			make_meta({ store_id: "docs", version: "v2", data_key: shared_key, content_hash: "shared-hash" }),
			shared_bytes,
		);

		const events: CopyProgressEvent[] = [];
		const result = await copy(source, dest, { on_progress: (e) => events.push(e) });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.versions_copied).toBe(2);
		expect(result.value.data_objects_copied).toBe(1);
		expect(events.filter((e) => e.type === "data_copied")).toHaveLength(1);

		const dest_metas = await collect(dest, "docs");
		expect(dest_metas).toHaveLength(2);
		expect(await bytes_at(dest, shared_key)).toEqual(shared_bytes);
	});

	it("honours the concurrency bound for data transfers", async () => {
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest_inner = create_file_backend({ base_path: DEST_DIR });

		let current = 0;
		let max_concurrent = 0;
		const dest: Backend = {
			...dest_inner,
			data: {
				...dest_inner.data,
				async put(data_key, data) {
					current++;
					max_concurrent = Math.max(max_concurrent, current);
					try {
						await new Promise((resolve) => setTimeout(resolve, 15));
						return await dest_inner.data.put(data_key, data);
					} finally {
						current--;
					}
				},
			},
		};

		for (let i = 0; i < 8; i++) {
			await seed(
				source,
				make_meta({ store_id: "docs", version: `v${String(i)}`, data_key: `docs/hash-v${String(i)}` }),
				new TextEncoder().encode(`payload-${String(i)}`),
			);
		}

		const result = await copy(source, dest, { concurrency: 2 });
		expect(result.ok).toBe(true);
		expect(max_concurrent).toBeLessThanOrEqual(2);
		expect(max_concurrent).toBeGreaterThan(1);
	});

	it("an interrupted copy leaves no dangling metadata at dest, and a re-run resumes to completion", async () => {
		// Closes the verification gap noted at review time: data-before-metadata
		// ordering (copy_version's doc comment) was checked "by reasoning" —
		// this test forces an actual mid-copy failure and asserts the invariant
		// holds, not just that the code reads that way.
		const source = create_file_backend({ base_path: SRC_DIR });
		const dest = create_file_backend({ base_path: DEST_DIR });

		const versions = ["v1", "v2", "v3", "v4"];
		for (const version of versions) {
			await seed(
				source,
				make_meta({ store_id: "docs", version, data_key: `docs/hash-${version}` }),
				new TextEncoder().encode(`payload-${version}`),
			);
		}

		const FAIL_AFTER = 2;
		let put_calls = 0;
		const failing_dest: Backend = {
			...dest,
			data: {
				...dest.data,
				async put(data_key, data) {
					put_calls++;
					if (put_calls > FAIL_AFTER) {
						return err({ kind: "storage_error", cause: new Error("simulated interruption"), operation: "put" });
					}
					return dest.data.put(data_key, data);
				},
			},
		};

		// concurrency: 1 makes the failure point deterministic — the Nth data
		// write fails, everything after it never starts.
		const interrupted = await copy(source, failing_dest, { concurrency: 1 });
		expect(interrupted.ok).toBe(false);

		const dest_metas_after_interruption = await collect(dest, "docs");
		expect(dest_metas_after_interruption.length).toBeGreaterThan(0);
		expect(dest_metas_after_interruption.length).toBeLessThan(versions.length);

		// The core invariant: every metadata row that DID land at dest has its
		// data already present. Interrupting mid-copy must never produce
		// metadata pointing at missing data.
		for (const meta of dest_metas_after_interruption) {
			expect(await dest.data.exists(meta.data_key)).toBe(true);
		}
		// And the converse for what didn't land: no orphaned metadata for the
		// versions that failed/never started.
		const copied_versions = new Set(dest_metas_after_interruption.map((m) => m.version));
		for (const version of versions) {
			if (copied_versions.has(version)) continue;
			const got = await dest.metadata.get("docs", version);
			expect(got.ok).toBe(false);
		}

		// Resumability: re-run against the real (non-failing) dest completes
		// the remaining versions without re-transferring what already landed.
		const resumed = await copy(source, dest);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.versions_copied).toBe(versions.length - dest_metas_after_interruption.length);
		expect(resumed.value.versions_skipped).toBe(dest_metas_after_interruption.length);

		const final_source_metas = await collect(source, "docs");
		const final_dest_metas = await collect(dest, "docs");
		expect(final_dest_metas).toEqual(final_source_metas);
		for (const version of versions) {
			expect(await dest.data.exists(`docs/hash-${version}`)).toBe(true);
		}
	});

	it("returns invalid_config when the source has no list_stores and no store filter is given", async () => {
		const inner = create_memory_backend();
		// Explicit member list (no `list_stores`) rather than destructuring it
		// away — memory_backend always implements list_stores, and copy() must
		// fall back to opts.stores when the method is absent entirely.
		const metadata_without_list_stores: MetadataClient = {
			get: inner.metadata.get,
			put: inner.metadata.put,
			delete: inner.metadata.delete,
			list: inner.metadata.list,
			get_latest: inner.metadata.get_latest,
			get_children: inner.metadata.get_children,
			find_by_hash: inner.metadata.find_by_hash,
		};
		const source: Backend = { ...inner, metadata: metadata_without_list_stores };
		const dest = create_file_backend({ base_path: DEST_DIR });

		const result = await copy(source, dest);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid_config");
	});

	describe("remote-fake → file", () => {
		let d1: FakeD1HttpServer;
		let s3: FakeS3Server;

		beforeEach(() => {
			d1 = create_fake_d1_http([corpus_snapshots]);
			s3 = create_fake_s3();
		});

		afterEach(() => {
			d1.stop();
			s3.stop();
		});

		it("clones from the remote (D1 HTTP + R2 S3) backend to a file backend", async () => {
			const source = create_remote_backend({
				account_id: "test-account",
				database_id: "test-database",
				api_token: "test-token",
				d1_base_url: d1.url,
				r2: {
					bucket: "test-bucket",
					access_key_id: "test-access-key-id",
					secret_access_key: "test-secret-access-key",
					endpoint: s3.url,
				},
			});
			const dest = create_file_backend({ base_path: DEST_DIR });

			const bytes = new TextEncoder().encode("remote-payload");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes);

			const result = await copy(source, dest);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.versions_copied).toBe(1);
			expect(result.value.data_objects_copied).toBe(1);

			expect(await bytes_at(dest, "docs/hash-v1")).toEqual(bytes);
			const dest_meta = await dest.metadata.get("docs", "v1");
			expect(dest_meta.ok).toBe(true);
			if (dest_meta.ok) expect(dest_meta.value.content_hash).toBe("hash-v1");

			const second = await copy(source, dest);
			expect(second.ok).toBe(true);
			if (second.ok) {
				expect(second.value.versions_copied).toBe(0);
				expect(second.value.data_objects_copied).toBe(0);
			}
		});
	});
});
