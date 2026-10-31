import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { create_file_backend } from "../../backend/file.js";
import { define_observation_type } from "../../observations/index.js";
import type { SnapshotMeta } from "../../types.js";
import { z } from "zod";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, "../.tmp/file-concurrency");

const make_meta = (store_id: string, version: string, data_key = `${store_id}/${version}`): SnapshotMeta => ({
	store_id,
	version,
	parents: [],
	created_at: new Date("2024-06-01T00:00:00.000Z"),
	content_hash: `hash-${version}`,
	content_type: "application/octet-stream",
	size_bytes: 0,
	data_key,
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("file backend - concurrency", () => {
	beforeEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("keeps every entry from 50 concurrent metadata.put calls on one store", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const versions = Array.from({ length: 50 }, (_, i) => `v${String(i)}`);

		const results = await Promise.all(versions.map((v) => backend.metadata.put(make_meta("items", v))));
		expect(results.every((r) => r.ok)).toBe(true);

		const listed: string[] = [];
		for await (const meta of backend.metadata.list("items")) listed.push(meta.version);
		expect(listed.toSorted()).toEqual(versions.toSorted());
	});

	it("keeps concurrent puts and deletes on one store consistent", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		await Promise.all(["a", "b", "c"].map((v) => backend.metadata.put(make_meta("items", v))));

		await Promise.all([
			backend.metadata.delete("items", "a"),
			backend.metadata.put(make_meta("items", "d")),
			backend.metadata.delete("items", "b"),
			backend.metadata.put(make_meta("items", "e")),
		]);

		const listed: string[] = [];
		for await (const meta of backend.metadata.list("items")) listed.push(meta.version);
		expect(listed.toSorted()).toEqual(["c", "d", "e"]);
	});

	it("does not lose a concurrent non-transactional put when apply_batch commits the same store", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const solo = Array.from({ length: 20 }, (_, i) => `solo${String(i)}`);

		const [batch, ...puts] = await Promise.all([
			backend.apply_batch!([
				{ type: "meta_put", meta: make_meta("items", "batched") },
				{ type: "data_put", data_key: "items/batched", bytes: bytes("x") },
			]),
			...solo.map((v) => backend.metadata.put(make_meta("items", v))),
		]);
		expect(batch.ok).toBe(true);
		expect(puts.every((r) => r.ok)).toBe(true);

		const listed: string[] = [];
		for await (const meta of backend.metadata.list("items")) listed.push(meta.version);
		expect(listed.toSorted()).toEqual([...solo, "batched"].toSorted());
	});
});

describe("file backend - observation concurrency", () => {
	beforeEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("keeps every observation from 30 concurrent observations.put calls", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const note_type = define_observation_type("note", z.object({ n: z.number() }));
		const source = { store_id: "items", version: "v1" };

		const results = await Promise.all(
			Array.from({ length: 30 }, (_, n) => backend.observations!.put(note_type, { source, content: { n } })),
		);
		expect(results.every((r) => r.ok)).toBe(true);

		const seen: number[] = [];
		for await (const obs of backend.observations!.query({ type: "note" })) seen.push((obs.content as { n: number }).n);
		expect(seen.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, n) => n));
	});
});

describe("file backend - data key aliasing guard", () => {
	beforeEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("rejects a second distinct key that maps to the same file name", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });

		const first = await backend.data.put("a/b", bytes("first"));
		expect(first.ok).toBe(true);

		const second = await backend.data.put("a_b", bytes("second"));
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.kind).toBe("storage_error");
		if (second.error.kind !== "storage_error") return;
		expect(second.error.cause.message).toContain("a/b");
		expect(second.error.cause.message).toContain("a_b");

		const got = await backend.data.get("a/b");
		expect(got.ok).toBe(true);
		if (got.ok) expect(new TextDecoder().decode(await got.value.bytes())).toBe("first");
	});

	it("allows rewriting the same key", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });

		expect((await backend.data.put("a/b", bytes("one"))).ok).toBe(true);
		expect((await backend.data.put("a/b", bytes("two"))).ok).toBe(true);
	});

	it("aborts apply_batch on a colliding data_put with nothing visible", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		expect((await backend.data.put("a/b", bytes("first"))).ok).toBe(true);

		const result = await backend.apply_batch!([
			{ type: "meta_put", meta: make_meta("items", "v1", "a_b") },
			{ type: "data_put", data_key: "a_b", bytes: bytes("second") },
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");

		expect((await readdir(TEST_DIR)).filter((e) => e.startsWith(".tx-"))).toHaveLength(0);
		expect((await backend.metadata.get("items", "v1")).ok).toBe(false);
		const got = await backend.data.get("a/b");
		if (got.ok) expect(new TextDecoder().decode(await got.value.bytes())).toBe("first");
	});

	it("aborts apply_batch on a collision inside the batch and claims nothing", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });

		const result = await backend.apply_batch!([
			{ type: "data_put", data_key: "x/y", bytes: bytes("1") },
			{ type: "data_put", data_key: "x_y", bytes: bytes("2") },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("transaction_aborted");

		// The aborted batch must not have claimed `x_y.bin`, so a later put of the other key succeeds.
		expect((await backend.data.put("x_y", bytes("ok"))).ok).toBe(true);
	});
});
