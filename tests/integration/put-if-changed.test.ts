import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import { create_corpus, define_store, json_codec, ok, text_codec } from "../../index.js";
import type { Backend, CorpusEvent, Corpus, Store } from "../../types.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".test-put-if-changed");

const item_schema = z.object({ id: z.string(), value: z.number() });
type Item = z.infer<typeof item_schema>;

const make_corpus = (b: Backend): Corpus<{ items: Store<Item> }> =>
	create_corpus()
		.with_backend(b)
		.with_store(define_store("items", json_codec(item_schema)))
		.build();

const list_versions = async (store: Store<Item>) => {
	const versions: string[] = [];
	for await (const m of store.list()) versions.push(m.version);
	return versions;
};

const chunks = () =>
	new ReadableStream<string>({
		start(controller) {
			controller.enqueue("hello ");
			controller.enqueue("world");
			controller.close();
		},
	});

const A: Item = { id: "x", value: 1 };
const B: Item = { id: "x", value: 2 };

const suites: { name: string; make: () => Backend; setup?: () => Promise<void>; cleanup?: () => Promise<void> }[] = [
	{ name: "memory", make: () => create_memory_backend() },
	{
		name: "file",
		make: () => create_file_backend({ base_path: TEST_DIR }),
		setup: async () => {
			await rm(TEST_DIR, { recursive: true, force: true });
			await mkdir(TEST_DIR, { recursive: true });
		},
		cleanup: () => rm(TEST_DIR, { recursive: true, force: true }),
	},
];

for (const suite of suites) {
	describe(`put if_changed (${suite.name})`, () => {
		beforeEach(async () => {
			await suite.setup?.();
		});
		afterEach(async () => {
			await suite.cleanup?.();
		});

		it("reports deduplicated true/false and unchanged false on plain puts", async () => {
			const corpus = make_corpus(suite.make());
			const first = await corpus.stores.items.put(A);
			const second = await corpus.stores.items.put(A);
			const third = await corpus.stores.items.put(B);

			expect(first.ok && first.value.deduplicated).toBe(false);
			expect(second.ok && second.value.deduplicated).toBe(true);
			expect(third.ok && third.value.deduplicated).toBe(false);
			expect([first, second, third].every((r) => r.ok && !r.value.unchanged)).toBe(true);
			expect(await list_versions(corpus.stores.items)).toHaveLength(3);
		});

		it("writes nothing and returns the latest meta when content is unchanged", async () => {
			const events: CorpusEvent[] = [];
			const backend = suite.make();
			backend.on_event = (e) => events.push(e);
			const corpus = make_corpus(backend);

			const first = await corpus.stores.items.put(A, { if_changed: true });
			expect(first.ok && first.value.unchanged).toBe(false);
			if (!first.ok) return;

			events.length = 0;
			const second = await corpus.stores.items.put(A, { if_changed: true });

			expect(second.ok).toBe(true);
			if (!second.ok) return;
			expect(second.value.unchanged).toBe(true);
			expect(second.value.version).toBe(first.value.version);
			expect(second.value.content_hash).toBe(first.value.content_hash);
			expect(await list_versions(corpus.stores.items)).toHaveLength(1);
			expect(events.filter((e) => e.type === "data_put" || e.type === "snapshot_put")).toHaveLength(0);
		});

		it("treats a revert A -> B -> A as changed", async () => {
			const corpus = make_corpus(suite.make());
			await corpus.stores.items.put(A, { if_changed: true });
			await corpus.stores.items.put(B, { if_changed: true });
			const third = await corpus.stores.items.put(A, { if_changed: true });

			expect(third.ok && third.value.unchanged).toBe(false);
			expect(third.ok && third.value.deduplicated).toBe(true);
			expect(await list_versions(corpus.stores.items)).toHaveLength(3);
		});

		it("writes into an empty store", async () => {
			const corpus = make_corpus(suite.make());
			const result = await corpus.stores.items.put(A, { if_changed: true });

			expect(result.ok && result.value.unchanged).toBe(false);
			expect(await list_versions(corpus.stores.items)).toHaveLength(1);
		});

		it("tx.put compares against the transaction-visible latest", async () => {
			const corpus = make_corpus(suite.make());
			const seeded = await corpus.stores.items.put(A);
			expect(seeded.ok).toBe(true);
			if (!seeded.ok) return;

			const result = await corpus.transaction(async (tx) => {
				const same_as_live = await tx.put(corpus.stores.items, A, { if_changed: true });
				if (!same_as_live.ok) return same_as_live;
				const changed = await tx.put(corpus.stores.items, B, { if_changed: true });
				if (!changed.ok) return changed;
				const same_as_buffered = await tx.put(corpus.stores.items, B, { if_changed: true });
				if (!same_as_buffered.ok) return same_as_buffered;
				return ok({
					same_as_live: same_as_live.value,
					changed: changed.value,
					same_as_buffered: same_as_buffered.value,
				});
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const { same_as_live, changed, same_as_buffered } = result.value.value;
			expect(same_as_live.unchanged).toBe(true);
			expect(same_as_live.version).toBe(seeded.value.version);
			expect(changed.unchanged).toBe(false);
			expect(same_as_buffered.unchanged).toBe(true);
			expect(same_as_buffered.version).toBe(changed.version);
			expect(await list_versions(corpus.stores.items)).toHaveLength(2);
		});

		it("tx.put ignores a live latest deleted earlier in the same transaction", async () => {
			const corpus = make_corpus(suite.make());
			const older = await corpus.stores.items.put(A);
			const newer = await corpus.stores.items.put(B);
			expect(older.ok && newer.ok).toBe(true);
			if (!older.ok || !newer.ok) return;

			const result = await corpus.transaction(async (tx) => {
				const deleted = await tx.delete(corpus.stores.items, newer.value.version);
				if (!deleted.ok) return deleted;
				const put = await tx.put(corpus.stores.items, A, { if_changed: true });
				if (!put.ok) return put;
				return ok(put.value);
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.value.unchanged).toBe(true);
			expect(result.value.value.version).toBe(older.value.version);
		});

		it("put_stream reports deduplicated/unchanged and honours if_changed", async () => {
			const corpus = create_corpus().with_backend(suite.make()).with_store(define_store("lines", text_codec())).build();
			const first = await corpus.stores.lines.put_stream(chunks(), { if_changed: true });
			const second = await corpus.stores.lines.put_stream(chunks(), { if_changed: true });

			expect(first.ok && first.value.unchanged).toBe(false);
			expect(second.ok && second.value.unchanged).toBe(true);
			if (!first.ok || !second.ok) return;
			expect(second.value.version).toBe(first.value.version);
		});
	});
}
