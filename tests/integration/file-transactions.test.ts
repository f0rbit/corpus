import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { create_file_backend, recover } from "../../backend/file";
import { create_corpus, define_store, json_codec, ok } from "../../index";
import type { Backend, BatchOp, Corpus, Store } from "../../types";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".test-file-transactions");

const ItemSchema = z.object({ id: z.string(), value: z.number() });
type Item = z.infer<typeof ItemSchema>;
const NoteSchema = z.object({ text: z.string() });
type Note = z.infer<typeof NoteSchema>;

type TxStores = { items: Store<Item>; notes: Store<Note> };

const make_corpus = (b: Backend): Corpus<TxStores> =>
	create_corpus()
		.with_backend(b)
		.with_store(define_store("items", json_codec(ItemSchema)))
		.with_store(define_store("notes", json_codec(NoteSchema)))
		.build() as Corpus<TxStores>;

describe("file backend - apply_batch", () => {
	beforeEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("commits a mixed batch (meta_put + data_put + meta_delete) atomically", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const corpus = make_corpus(backend);

		// Pre-seed a snapshot we'll delete inside the transaction.
		const initial = await corpus.stores.items.put({ id: "doomed", value: 0 });
		expect(initial.ok).toBe(true);
		if (!initial.ok) return;

		const result = await corpus.transaction(async (tx) => {
			const a = await tx.put(corpus.stores.items, { id: "a", value: 1 });
			if (!a.ok) return a;
			const b = await tx.put(corpus.stores.notes, { text: "hello" });
			if (!b.ok) return b;
			const d = await tx.delete(corpus.stores.items, initial.value.version);
			if (!d.ok) return d;
			return ok({ a: a.value.version, b: b.value.version });
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const got_a = await corpus.stores.items.get(result.value.value.a);
		expect(got_a.ok).toBe(true);
		if (got_a.ok) expect(got_a.value.data).toEqual({ id: "a", value: 1 });

		const got_b = await corpus.stores.notes.get(result.value.value.b);
		expect(got_b.ok).toBe(true);
		if (got_b.ok) expect(got_b.value.data).toEqual({ text: "hello" });

		// The deleted snapshot is gone.
		const gone = await corpus.stores.items.get_meta(initial.value.version);
		expect(gone.ok).toBe(false);

		// No leftover staging dirs.
		const entries = await readdir(TEST_DIR);
		const staging = entries.filter((e) => e.startsWith(".tx-"));
		expect(staging).toHaveLength(0);
	});

	it("aborts cleanly on staging-phase failure and removes the staging dir", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });

		// Inject a SnapshotMeta with a circular reference to force
		// JSON.stringify to throw during the staging phase. Nothing is
		// visible on disk, the staging dir is nuked, and we get a clean
		// `transaction_aborted`.
		const meta: any = { store_id: "items", version: "v1" };
		meta.self = meta;

		const result = await backend.apply_batch!([{ type: "meta_put", meta } as BatchOp]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");

		// No staging dir left behind.
		const entries = await readdir(TEST_DIR);
		expect(entries.filter((e) => e.startsWith(".tx-"))).toHaveLength(0);

		// Live tree is untouched — `items` directory was never created.
		const lookup = await backend.metadata.get("items", "v1");
		expect(lookup.ok).toBe(false);
	});

	it("recover() removes leftover .tx-* staging dirs without touching the live tree", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const corpus = make_corpus(backend);

		// Lay down a real snapshot in the live tree.
		const live = await corpus.stores.items.put({ id: "alive", value: 42 });
		expect(live.ok).toBe(true);
		if (!live.ok) return;

		// Drop two fake `.tx-*` directories with arbitrary contents to
		// simulate a previous crash mid-commit. `recover()` should remove
		// both and leave the live snapshot untouched.
		const fake_a = join(TEST_DIR, ".tx-fake-a");
		const fake_b = join(TEST_DIR, ".tx-fake-b");
		await mkdir(join(fake_a, "meta"), { recursive: true });
		await writeFile(join(fake_a, "meta", "items.json"), JSON.stringify([]));
		await mkdir(join(fake_b, "data"), { recursive: true });
		await writeFile(join(fake_b, "data", "items_garbage.bin"), new Uint8Array([1, 2, 3]));

		const result = await recover(TEST_DIR);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.aborted).toBe(2);
		expect(result.value.recovered).toBe(2);

		// Staging dirs gone.
		const remaining = await readdir(TEST_DIR);
		expect(remaining.filter((e) => e.startsWith(".tx-"))).toHaveLength(0);

		// Live snapshot is intact and readable.
		const got = await corpus.stores.items.get(live.value.version);
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.value.data).toEqual({ id: "alive", value: 42 });
	});

	it("recover() reports zero work when there are no staging dirs", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const corpus = make_corpus(backend);

		const live = await corpus.stores.items.put({ id: "x", value: 1 });
		expect(live.ok).toBe(true);

		const result = await recover(TEST_DIR);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.aborted).toBe(0);
		expect(result.value.recovered).toBe(0);
	});

	it("metadata.list does not surface staging-dir contents", async () => {
		const backend = create_file_backend({ base_path: TEST_DIR });
		const corpus = make_corpus(backend);

		// Real snapshot.
		const live = await corpus.stores.items.put({ id: "real", value: 1 });
		expect(live.ok).toBe(true);

		// Hand-craft a `.tx-*` dir containing a fully-populated meta map
		// for a fictitious `secret-store`. Without proper filtering, a
		// `metadata.list(undefined)` would walk into `.tx-fake/meta/...`
		// and surface those entries.
		const tx_dir = join(TEST_DIR, ".tx-malicious");
		await mkdir(join(tx_dir, "meta"), { recursive: true });
		await writeFile(
			join(tx_dir, "meta", "secret-store.json"),
			JSON.stringify([["v1", { store_id: "secret-store", version: "v1" }]]),
		);

		// list_all_stores should NOT include `.tx-malicious` — assert via
		// the metadata client's behaviour.
		const items_seen: string[] = [];
		for await (const meta of backend.metadata.list("secret-store")) {
			items_seen.push(meta.version);
		}
		expect(items_seen).toHaveLength(0);

		// Cleanup the fake dir explicitly so afterEach is happy.
		await rm(tx_dir, { recursive: true, force: true });
	});
});
