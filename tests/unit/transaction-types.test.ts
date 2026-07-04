import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	err,
	ok,
	type Corpus,
	type Store,
} from "../../index";

// Phase 1 transaction tests — exercise the sequential-fallback path against
// the memory backend (which does not implement apply_batch yet — Phase 2).
// Once memory.apply_batch lands, these tests still pass; they assert
// observable invariants, not which path was taken.

const ItemSchema = z.object({ id: z.string() });
type Item = z.infer<typeof ItemSchema>;

function make_corpus(): Corpus<{ items: Store<Item> }> {
	return create_corpus()
		.with_backend(create_memory_backend())
		.with_store(define_store("items", json_codec(ItemSchema)))
		.build() as Corpus<{ items: Store<Item> }>;
}

describe("corpus.transaction (Phase 1 fallback)", () => {
	describe("successful commit via sequential fallback", () => {
		it("commits all puts and surfaces them in TransactionResult.commits", async () => {
			const corpus = make_corpus();

			const result = await corpus.transaction(async (tx) => {
				const a = await tx.put(corpus.stores.items, { id: "a" });
				if (!a.ok) return a;
				const b = await tx.put(corpus.stores.items, { id: "b" });
				if (!b.ok) return b;
				return ok({ a: a.value.version, b: b.value.version });
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.commits).toHaveLength(2);
			expect(result.value.commits[0]?.store_id).toBe("items");
			expect(result.value.observations).toHaveLength(0);
			expect(result.value.value.a).toBeString();
			expect(result.value.value.b).toBeString();

			// reads after commit see the values
			const got_a = await corpus.stores.items.get(result.value.value.a);
			expect(got_a.ok).toBe(true);
			if (got_a.ok) expect(got_a.value.data.id).toBe("a");

			const got_b = await corpus.stores.items.get(result.value.value.b);
			expect(got_b.ok).toBe(true);
			if (got_b.ok) expect(got_b.value.data.id).toBe("b");
		});

		it("supports read-your-writes within the same transaction", async () => {
			const corpus = make_corpus();

			const result = await corpus.transaction(async (tx) => {
				const put_result = await tx.put(corpus.stores.items, { id: "rw" });
				if (!put_result.ok) return put_result;

				const buffered = await tx.get(corpus.stores.items, put_result.value.version);
				if (!buffered.ok) return buffered;
				return ok(buffered.value.data.id);
			});

			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.value).toBe("rw");
		});

		it("dedups identical content within the same transaction (one data_put for two meta_puts)", async () => {
			const c = make_corpus();

			const result = await c.transaction(async (tx) => {
				const a = await tx.put(c.stores.items, { id: "same" });
				if (!a.ok) return a;
				const b = await tx.put(c.stores.items, { id: "same" });
				if (!b.ok) return b;
				return ok({ a: a.value, b: b.value });
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.commits).toHaveLength(2);
			// dedup: both metas share a data_key, and the underlying data is fetched once
			expect(result.value.commits[0]?.data_key).toBe(result.value.commits[1]?.data_key);
			const data_a = await c.data.get(result.value.commits[0]!.data_key);
			expect(data_a.ok).toBe(true);
		});
	});

	describe("body returns err()", () => {
		it("returns transaction_aborted with reason: 'returned_err' and writes nothing", async () => {
			const corpus = make_corpus();

			const result = await corpus.transaction(async (tx) => {
				const a = await tx.put(corpus.stores.items, { id: "first" });
				if (!a.ok) return a;
				return err({ kind: "invalid_config" as const, message: "intentional abort" });
			});

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("transaction_aborted");
			if (result.error.kind !== "transaction_aborted") return;
			expect(result.error.reason).toBe("returned_err");

			// nothing leaked: list returns no snapshots
			const listed: unknown[] = [];
			for await (const meta of corpus.stores.items.list()) listed.push(meta);
			expect(listed).toHaveLength(0);
		});
	});

	describe("body throws", () => {
		it("returns transaction_aborted with reason: 'threw' and writes nothing", async () => {
			const corpus = make_corpus();

			const result = await corpus.transaction(async (tx) => {
				await tx.put(corpus.stores.items, { id: "before-throw" });
				throw new Error("boom");
			});

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("transaction_aborted");
			if (result.error.kind !== "transaction_aborted") return;
			expect(result.error.reason).toBe("threw");
			expect(result.error.cause).toBeInstanceOf(Error);
			expect(result.error.cause?.message).toBe("boom");

			const listed: unknown[] = [];
			for await (const meta of corpus.stores.items.list()) listed.push(meta);
			expect(listed).toHaveLength(0);
		});
	});

	describe("nested transaction", () => {
		it("returns invalid_config when transaction() is called inside a transaction body", async () => {
			const corpus = make_corpus();

			const result = await corpus.transaction(async (_tx) => {
				const inner = await corpus.transaction(async () => ok(1));
				expect(inner.ok).toBe(false);
				if (!inner.ok) {
					expect(inner.error.kind).toBe("invalid_config");
				}
				return ok(undefined);
			});

			expect(result.ok).toBe(true);
		});

		it("releases the lock after the outer transaction completes", async () => {
			const corpus = make_corpus();

			const first = await corpus.transaction(async () => ok(1));
			expect(first.ok).toBe(true);

			const second = await corpus.transaction(async () => ok(2));
			expect(second.ok).toBe(true);
		});

		it("releases the lock after the outer transaction throws", async () => {
			const corpus = make_corpus();

			const first = await corpus.transaction(async () => {
				throw new Error("first boom");
			});
			expect(first.ok).toBe(false);

			const second = await corpus.transaction(async () => ok("recovered"));
			expect(second.ok).toBe(true);
			if (second.ok) expect(second.value.value).toBe("recovered");
		});
	});

	describe("delete via tx", () => {
		it("buffers a meta_delete op and applies it on commit", async () => {
			const corpus = make_corpus();
			const initial = await corpus.stores.items.put({ id: "to-be-deleted" });
			expect(initial.ok).toBe(true);
			if (!initial.ok) return;

			const result = await corpus.transaction(async (tx) => {
				return tx.delete(corpus.stores.items, initial.value.version);
			});

			expect(result.ok).toBe(true);

			const after = await corpus.stores.items.get_meta(initial.value.version);
			expect(after.ok).toBe(false);
		});
	});
});
