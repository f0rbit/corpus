import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";
import { create_corpus, create_memory_backend, define_store, json_codec, type CorpusEvent, type Corpus, type Store } from "../../index";

const ItemSchema = z.object({
	id: z.string(),
	text: z.string(),
});

const TimelineSchema = z.object({
	items: z.array(ItemSchema),
	cursor: z.string().optional(),
});

type Timeline = z.infer<typeof TimelineSchema>;

describe("memory backend", () => {
	let events: CorpusEvent[];
	let corpus: Corpus<{ timelines: Store<Timeline> }>;

	beforeEach(() => {
		events = [];
		corpus = create_corpus()
			.with_backend(create_memory_backend({ on_event: e => events.push(e) }))
			.with_store(define_store("timelines", json_codec(TimelineSchema)))
			.build();
	});

	describe("basic crud", () => {
		it("puts and gets a snapshot", async () => {
			const data: Timeline = { items: [{ id: "1", text: "hello" }] };

			const put_result = await corpus.stores.timelines.put(data);
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			expect(put_result.value.store_id).toBe("timelines");
			expect(put_result.value.version).toBeString();
			expect(put_result.value.content_hash).toBeString();

			const version = put_result.value.version;
			const get_result = await corpus.stores.timelines.get(version);
			expect(get_result.ok).toBe(true);
			if (!get_result.ok) return;

			expect(get_result.value.data).toEqual(data);
			expect(get_result.value.meta.version).toBe(version);
		});

		it("returns not_found for missing version", async () => {
			const result = await corpus.stores.timelines.get("nonexistent");

			expect(result.ok).toBe(false);
			if (result.ok) return;

			expect(result.error.kind).toBe("not_found");
			if (result.error.kind !== "not_found") return;
			expect(result.error.store_id).toBe("timelines");
			expect(result.error.version).toBe("nonexistent");
		});

		it("deletes a snapshot", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [] });
			if (!put_result.ok) return;
			const version = put_result.value.version;

			const delete_result = await corpus.stores.timelines.delete(version);
			expect(delete_result.ok).toBe(true);

			const get_result = await corpus.stores.timelines.get(version);
			expect(get_result.ok).toBe(false);
		});

		it("returns not_found when deleting non-existent", async () => {
			const result = await corpus.stores.timelines.delete("nonexistent");

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});

		it("get_latest returns most recent by created_at", async () => {
			await corpus.stores.timelines.put({ items: [{ id: "1", text: "first" }] });
			await new Promise(r => setTimeout(r, 5));
			await corpus.stores.timelines.put({ items: [{ id: "2", text: "second" }] });
			await new Promise(r => setTimeout(r, 5));
			const last_put = await corpus.stores.timelines.put({ items: [{ id: "3", text: "third" }] });
			expect(last_put.ok).toBe(true);
			if (!last_put.ok) return;

			const result = await corpus.stores.timelines.get_latest();
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.meta.version).toBe(last_put.value.version);
			expect(result.value.data.items[0]?.text).toBe("third");
		});

		it("get_latest returns not_found on empty store", async () => {
			const result = await corpus.stores.timelines.get_latest();

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});

		it("list returns all snapshots newest first", async () => {
			const put1 = await corpus.stores.timelines.put({ items: [] });
			await new Promise(r => setTimeout(r, 5));
			const put2 = await corpus.stores.timelines.put({ items: [] });
			await new Promise(r => setTimeout(r, 5));
			const put3 = await corpus.stores.timelines.put({ items: [] });
			if (!put1.ok || !put2.ok || !put3.ok) return;

			const versions: string[] = [];
			for await (const meta of corpus.stores.timelines.list()) {
				versions.push(meta.version);
			}

			expect(versions).toHaveLength(3);
			expect(versions[0]).toBe(put3.value.version);
			expect(versions[2]).toBe(put1.value.version);
		});

		it("get_meta returns only metadata without data", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [{ id: "1", text: "test" }] });
			if (!put_result.ok) return;
			const version = put_result.value.version;

			const result = await corpus.stores.timelines.get_meta(version);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.version).toBe(version);
			expect(result.value.content_hash).toBeString();
			expect((result.value as any).data).toBeUndefined();
		});
	});

	describe("deduplication", () => {
		it("reuses data_key for identical content", async () => {
			const data: Timeline = { items: [{ id: "1", text: "same" }] };

			const result1 = await corpus.stores.timelines.put(data);
			const result2 = await corpus.stores.timelines.put(data);

			expect(result1.ok && result2.ok).toBe(true);
			if (!result1.ok || !result2.ok) return;

			expect(result1.value.content_hash).toBe(result2.value.content_hash);
			expect(result1.value.data_key).toBe(result2.value.data_key);
		});

		it("uses different data_key for different content", async () => {
			const result1 = await corpus.stores.timelines.put({ items: [{ id: "1", text: "a" }] });
			const result2 = await corpus.stores.timelines.put({ items: [{ id: "2", text: "b" }] });

			expect(result1.ok && result2.ok).toBe(true);
			if (!result1.ok || !result2.ok) return;

			expect(result1.value.content_hash).not.toBe(result2.value.content_hash);
			expect(result1.value.data_key).not.toBe(result2.value.data_key);
		});

		it("emits deduplicated event on second put", async () => {
			const data: Timeline = { items: [] };

			await corpus.stores.timelines.put(data);
			await corpus.stores.timelines.put(data);

			const data_puts = events.filter(e => e.type === "data_put") as Array<Extract<CorpusEvent, { type: "data_put" }>>;

			expect(data_puts).toHaveLength(2);
			expect(data_puts[0]?.deduplicated).toBe(false);
			expect(data_puts[1]?.deduplicated).toBe(true);
		});
	});

	describe("lineage tracking", () => {
		it("stores parents on put", async () => {
			const parent = await corpus.stores.timelines.put({ items: [] });
			if (!parent.ok) return;

			const result = await corpus.stores.timelines.put(
				{ items: [] },
				{
					parents: [{ store_id: "timelines", version: parent.value.version, role: "source" }],
				}
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.parents).toHaveLength(1);
			expect(result.value.parents[0]?.store_id).toBe("timelines");
			expect(result.value.parents[0]?.version).toBe(parent.value.version);
			expect(result.value.parents[0]?.role).toBe("source");
		});

		it("preserves parents on get", async () => {
			const parent = await corpus.stores.timelines.put({ items: [] });
			if (!parent.ok) return;

			const child = await corpus.stores.timelines.put(
				{ items: [] },
				{
					parents: [{ store_id: "timelines", version: parent.value.version }],
				}
			);
			if (!child.ok) return;

			const result = await corpus.stores.timelines.get(child.value.version);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.meta.parents).toHaveLength(1);
			expect(result.value.meta.parents[0]?.version).toBe(parent.value.version);
		});

		it("get_children returns snapshots with matching parent", async () => {
			const parent = await corpus.stores.timelines.put({ items: [] });
			if (!parent.ok) return;

			const child1 = await corpus.stores.timelines.put(
				{ items: [{ id: "1", text: "child1" }] },
				{
					parents: [{ store_id: "timelines", version: parent.value.version }],
				}
			);
			const child2 = await corpus.stores.timelines.put(
				{ items: [{ id: "2", text: "child2" }] },
				{
					parents: [{ store_id: "timelines", version: parent.value.version }],
				}
			);
			const unrelated = await corpus.stores.timelines.put({ items: [{ id: "3", text: "unrelated" }] });
			if (!child1.ok || !child2.ok || !unrelated.ok) return;

			const children: string[] = [];
			for await (const meta of corpus.metadata.get_children("timelines", parent.value.version)) {
				children.push(meta.version);
			}

			expect(children).toHaveLength(2);
			expect(children).toContain(child1.value.version);
			expect(children).toContain(child2.value.version);
			expect(children).not.toContain(unrelated.value.version);
		});

		it("supports multiple parents", async () => {
			const source1 = await corpus.stores.timelines.put({ items: [{ id: "1", text: "s1" }] });
			const source2 = await corpus.stores.timelines.put({ items: [{ id: "2", text: "s2" }] });
			if (!source1.ok || !source2.ok) return;

			const result = await corpus.stores.timelines.put(
				{ items: [] },
				{
					parents: [
						{ store_id: "timelines", version: source1.value.version, role: "primary" },
						{ store_id: "timelines", version: source2.value.version, role: "secondary" },
					],
				}
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.parents).toHaveLength(2);
		});
	});

	describe("tags and filtering", () => {
		it("stores tags on put", async () => {
			const result = await corpus.stores.timelines.put(
				{ items: [] },
				{
					tags: ["important", "daily"],
				}
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.tags).toEqual(["important", "daily"]);
		});

		it("filters list by tags", async () => {
			const v1 = await corpus.stores.timelines.put({ items: [{ id: "1", text: "v1" }] }, { tags: ["a"] });
			const v2 = await corpus.stores.timelines.put({ items: [{ id: "2", text: "v2" }] }, { tags: ["b"] });
			const v3 = await corpus.stores.timelines.put({ items: [{ id: "3", text: "v3" }] }, { tags: ["a", "b"] });
			if (!v1.ok || !v2.ok || !v3.ok) return;

			const tagged_a: string[] = [];
			for await (const meta of corpus.stores.timelines.list({ tags: ["a"] })) {
				tagged_a.push(meta.version);
			}

			expect(tagged_a).toHaveLength(2);
			expect(tagged_a).toContain(v1.value.version);
			expect(tagged_a).toContain(v3.value.version);
		});

		it("filters list by multiple tags using AND logic", async () => {
			const v1 = await corpus.stores.timelines.put({ items: [{ id: "1", text: "v1" }] }, { tags: ["a"] });
			const v2 = await corpus.stores.timelines.put({ items: [{ id: "2", text: "v2" }] }, { tags: ["b"] });
			const v3 = await corpus.stores.timelines.put({ items: [{ id: "3", text: "v3" }] }, { tags: ["a", "b"] });
			const v4 = await corpus.stores.timelines.put({ items: [{ id: "4", text: "v4" }] }, { tags: ["a", "b", "c"] });
			if (!v1.ok || !v2.ok || !v3.ok || !v4.ok) return;

			const tagged_ab: string[] = [];
			for await (const meta of corpus.stores.timelines.list({ tags: ["a", "b"] })) {
				tagged_ab.push(meta.version);
			}

			expect(tagged_ab).toHaveLength(2);
			expect(tagged_ab).toContain(v3.value.version);
			expect(tagged_ab).toContain(v4.value.version);
			expect(tagged_ab).not.toContain(v1.value.version);
			expect(tagged_ab).not.toContain(v2.value.version);
		});

		it("filters list with limit", async () => {
			await corpus.stores.timelines.put({ items: [{ id: "1", text: "v1" }] });
			await corpus.stores.timelines.put({ items: [{ id: "2", text: "v2" }] });
			await corpus.stores.timelines.put({ items: [{ id: "3", text: "v3" }] });

			const limited: string[] = [];
			for await (const meta of corpus.stores.timelines.list({ limit: 2 })) {
				limited.push(meta.version);
			}

			expect(limited).toHaveLength(2);
		});

		it("filters list by before date", async () => {
			const now = new Date();
			await corpus.stores.timelines.put({ items: [] });

			const future = new Date(now.getTime() + 10000);

			const before_future: string[] = [];
			for await (const meta of corpus.stores.timelines.list({ before: future })) {
				before_future.push(meta.version);
			}
			expect(before_future).toHaveLength(1);

			const past = new Date(now.getTime() - 10000);
			const before_past: string[] = [];
			for await (const meta of corpus.stores.timelines.list({ before: past })) {
				before_past.push(meta.version);
			}
			expect(before_past).toHaveLength(0);
		});
	});

	describe("event observability", () => {
		it("fires events for put operation", async () => {
			await corpus.stores.timelines.put({ items: [] });

			const event_types = events.map(e => e.type);

			expect(event_types).toContain("data_put");
			expect(event_types).toContain("meta_put");
			expect(event_types).toContain("snapshot_put");
		});

		it("fires events for get operation", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [] });
			if (!put_result.ok) return;
			events.length = 0;

			await corpus.stores.timelines.get(put_result.value.version);

			const event_types = events.map(e => e.type);
			expect(event_types).toContain("meta_get");
			expect(event_types).toContain("data_get");
			expect(event_types).toContain("snapshot_get");
		});

		it("fires meta_get with found=false for missing", async () => {
			await corpus.stores.timelines.get("nonexistent");

			const meta_get = events.find(e => e.type === "meta_get") as Extract<CorpusEvent, { type: "meta_get" }>;
			expect(meta_get).toBeDefined();
			expect(meta_get.found).toBe(false);
		});

		it("fires meta_list with count", async () => {
			await corpus.stores.timelines.put({ items: [{ id: "1", text: "a" }] });
			await corpus.stores.timelines.put({ items: [{ id: "2", text: "b" }] });
			events.length = 0;

			for await (const _ of corpus.stores.timelines.list()) {
			}

			const meta_list = events.find(e => e.type === "meta_list") as Extract<CorpusEvent, { type: "meta_list" }>;
			expect(meta_list).toBeDefined();
			expect(meta_list.count).toBe(2);
		});

		it("records snapshot_put with content_hash", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [] });
			if (!put_result.ok) return;

			const snapshot_put = events.find(e => e.type === "snapshot_put") as Extract<CorpusEvent, { type: "snapshot_put" }>;
			expect(snapshot_put).toBeDefined();
			expect(snapshot_put.content_hash).toBeString();
			expect(snapshot_put.store_id).toBe("timelines");
			expect(snapshot_put.version).toBe(put_result.value.version);
		});
	});

	describe("multiple stores", () => {
		const UserSchema = z.object({
			name: z.string(),
			email: z.string(),
		});
		type User = z.infer<typeof UserSchema>;

		it("supports multiple independent stores", async () => {
			const multi_corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("timelines", json_codec(TimelineSchema)))
				.with_store(define_store("users", json_codec(UserSchema)))
				.build();

			const t1 = await multi_corpus.stores.timelines.put({ items: [] });
			const u1 = await multi_corpus.stores.users.put({ name: "Alice", email: "alice@test.com" });
			if (!t1.ok || !u1.ok) return;

			const timeline = await multi_corpus.stores.timelines.get(t1.value.version);
			const user = await multi_corpus.stores.users.get(u1.value.version);

			expect(timeline.ok).toBe(true);
			expect(user.ok).toBe(true);

			if (timeline.ok) {
				expect(timeline.value.data.items).toEqual([]);
			}
			if (user.ok) {
				expect(user.value.data.name).toBe("Alice");
			}
		});

		it("stores are isolated from each other", async () => {
			const multi_corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("store_a", json_codec(ItemSchema)))
				.with_store(define_store("store_b", json_codec(ItemSchema)))
				.build();

			const a = await multi_corpus.stores.store_a.put({ id: "1", text: "a" });
			const b = await multi_corpus.stores.store_b.put({ id: "1", text: "b" });
			if (!a.ok || !b.ok) return;

			const a_result = await multi_corpus.stores.store_a.get(a.value.version);
			const b_result = await multi_corpus.stores.store_b.get(b.value.version);

			expect(a_result.ok && b_result.ok).toBe(true);
			if (a_result.ok && b_result.ok) {
				expect(a_result.value.data.text).toBe("a");
				expect(b_result.value.data.text).toBe("b");
			}
		});

		it("list only returns snapshots from own store", async () => {
			const multi_corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("store_a", json_codec(ItemSchema)))
				.with_store(define_store("store_b", json_codec(ItemSchema)))
				.build();

			const a1 = await multi_corpus.stores.store_a.put({ id: "1", text: "a" });
			const a2 = await multi_corpus.stores.store_a.put({ id: "2", text: "a" });
			const b1 = await multi_corpus.stores.store_b.put({ id: "1", text: "b" });
			if (!a1.ok || !a2.ok || !b1.ok) return;

			const a_versions: string[] = [];
			for await (const meta of multi_corpus.stores.store_a.list()) {
				a_versions.push(meta.version);
			}

			expect(a_versions).toHaveLength(2);
			expect(a_versions).toContain(a1.value.version);
			expect(a_versions).toContain(a2.value.version);
			expect(a_versions).not.toContain(b1.value.version);
		});
	});

	describe("invoked_at metadata", () => {
		it("stores invoked_at timestamp", async () => {
			const invoked = new Date("2024-01-15T10:00:00Z");

			const result = await corpus.stores.timelines.put(
				{ items: [] },
				{
					invoked_at: invoked,
				}
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.invoked_at).toEqual(invoked);
		});

		it("preserves invoked_at on get", async () => {
			const invoked = new Date("2024-01-15T10:00:00Z");
			const put_result = await corpus.stores.timelines.put({ items: [] }, { invoked_at: invoked });
			if (!put_result.ok) return;

			const result = await corpus.stores.timelines.get(put_result.value.version);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.meta.invoked_at).toEqual(invoked);
		});
	});
});
