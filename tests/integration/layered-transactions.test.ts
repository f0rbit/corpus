import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_layered_backend,
	create_memory_backend,
	define_store,
	json_codec,
	ok,
	type Backend,
	type BatchOp,
	type Corpus,
	type CorpusError,
	type Result,
	type Store,
} from "../../index.js";

const item_schema = z.object({ id: z.string() });
type Item = z.infer<typeof item_schema>;

type TxStores = { items: Store<Item> };

const make_corpus = (b: Backend): Corpus<TxStores> =>
	create_corpus()
		.with_backend(b)
		.with_store(define_store("items", json_codec(item_schema)))
		.build();

describe("layered backend - apply_batch", () => {
	it("forwards apply_batch to the bottom write layer; cache stays cold until read", async () => {
		const cache = create_memory_backend();
		const persist = create_memory_backend();
		const layered = create_layered_backend({
			read: [cache, persist],
			write: [cache, persist],
		});

		const corpus = make_corpus(layered);

		const result = await corpus.transaction(async (tx) => {
			const put = await tx.put(corpus.stores.items, { id: "tx-only" });
			if (!put.ok) return put;
			return ok(put.value.version);
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Bottom write layer received the commit.
		const in_persist = await persist.metadata.get("items", result.value.value);
		expect(in_persist.ok).toBe(true);

		// Cache layer (top of write) is intentionally untouched — transactional
		// commits land at the bottom, the cache fills lazily on read.
		const in_cache = await cache.metadata.get("items", result.value.value);
		expect(in_cache.ok).toBe(false);
	});

	it("omits apply_batch when the bottom write layer does not support it", () => {
		const stub_no_batch: Backend = {
			metadata: create_memory_backend().metadata,
			data: create_memory_backend().data,
			// intentionally no apply_batch
		};
		const layered = create_layered_backend({
			read: [stub_no_batch],
			write: [stub_no_batch],
		});

		expect(layered.apply_batch).toBeUndefined();
	});

	it("exposes apply_batch when only the bottom of multiple write layers supports it", () => {
		const top_no_batch: Backend = {
			metadata: create_memory_backend().metadata,
			data: create_memory_backend().data,
		};
		const bottom_with_batch = create_memory_backend();
		const layered = create_layered_backend({
			read: [top_no_batch, bottom_with_batch],
			write: [top_no_batch, bottom_with_batch],
		});

		expect(typeof layered.apply_batch).toBe("function");
	});

	it("bottom-only apply_batch surfaces failures from the bottom layer", async () => {
		const failing_bottom: Backend = {
			metadata: create_memory_backend().metadata,
			data: create_memory_backend().data,
			apply_batch: async (_ops: BatchOp[]): Promise<Result<void, CorpusError>> => ({
				ok: false,
				error: {
					kind: "transaction_aborted",
					reason: "apply_batch_failed",
					cause: new Error("bottom blew up"),
				},
			}),
		};
		const layered = create_layered_backend({
			read: [failing_bottom],
			write: [failing_bottom],
		});

		const corpus = make_corpus(layered);
		const result = await corpus.transaction(async (tx) => {
			const put = await tx.put(corpus.stores.items, { id: "will-fail" });
			if (!put.ok) return put;
			return ok(undefined);
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");
	});

	it("after commit, a read through the layered backend returns the committed value", async () => {
		const cache = create_memory_backend();
		const persist = create_memory_backend();
		const layered = create_layered_backend({
			read: [cache, persist],
			write: [cache, persist],
		});

		const corpus = make_corpus(layered);

		const tx_result = await corpus.transaction(async (tx) => {
			const put = await tx.put(corpus.stores.items, { id: "lazy-fill" });
			if (!put.ok) return put;
			return ok(put.value.version);
		});

		expect(tx_result.ok).toBe(true);
		if (!tx_result.ok) return;

		// Read via the layered backend pulls from persist (cache is empty for
		// this version) and returns the value the transaction committed.
		const got = await corpus.stores.items.get(tx_result.value.value);
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.value.data).toEqual({ id: "lazy-fill" });
	});
});
