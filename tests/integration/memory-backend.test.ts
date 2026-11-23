import { describe, it, expect, beforeEach } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	type CorpusEvent,
	type Corpus,
	type Store,
} from "../../index.js";

const item_schema = z.object({
	id: z.string(),
	text: z.string(),
});

const timeline_schema = z.object({
	items: z.array(item_schema),
	cursor: z.string().optional(),
});

type Timeline = z.infer<typeof timeline_schema>;

describe("memory backend", () => {
	let events: CorpusEvent[];
	let corpus: Corpus<{ timelines: Store<Timeline> }>;

	beforeEach(() => {
		events = [];
		corpus = create_corpus()
			.with_backend(create_memory_backend({ on_event: (e) => events.push(e) }))
			.with_store(define_store("timelines", json_codec(timeline_schema)))
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

		// Kept: the contract/model cover backend.metadata.delete, not corpus.ts's store-level delete wrapper.
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

		it("get_meta returns only metadata without data", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [{ id: "1", text: "test" }] });
			if (!put_result.ok) return;
			const version = put_result.value.version;

			const result = await corpus.stores.timelines.get_meta(version);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.version).toBe(version);
			expect(result.value.content_hash).toBeString();
			expect(result.value).not.toHaveProperty("data");
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

			const data_puts = events.filter((e) => e.type === "data_put");

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
				},
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
				},
			);
			if (!child.ok) return;

			const result = await corpus.stores.timelines.get(child.value.version);
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.meta.parents).toHaveLength(1);
			expect(result.value.meta.parents[0]?.version).toBe(parent.value.version);
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
				},
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
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.tags).toEqual(["important", "daily"]);
		});
	});

	describe("event observability", () => {
		it("fires events for put operation", async () => {
			await corpus.stores.timelines.put({ items: [] });

			const event_types = events.map((e) => e.type);

			expect(event_types).toContain("data_put");
			expect(event_types).toContain("meta_put");
			expect(event_types).toContain("snapshot_put");
		});

		it("fires events for get operation", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [] });
			if (!put_result.ok) return;
			events.length = 0;

			await corpus.stores.timelines.get(put_result.value.version);

			const event_types = events.map((e) => e.type);
			expect(event_types).toContain("meta_get");
			expect(event_types).toContain("data_get");
			expect(event_types).toContain("snapshot_get");
		});

		it("fires meta_get with found=false for missing", async () => {
			await corpus.stores.timelines.get("nonexistent");

			const meta_get = events.find((e) => e.type === "meta_get") as Extract<CorpusEvent, { type: "meta_get" }>;
			expect(meta_get).toBeDefined();
			expect(meta_get.found).toBe(false);
		});

		it("fires meta_list with count", async () => {
			await corpus.stores.timelines.put({ items: [{ id: "1", text: "a" }] });
			await corpus.stores.timelines.put({ items: [{ id: "2", text: "b" }] });
			events.length = 0;

			await Array.fromAsync(corpus.stores.timelines.list());

			const meta_list = events.find((e) => e.type === "meta_list") as Extract<CorpusEvent, { type: "meta_list" }>;
			expect(meta_list).toBeDefined();
			expect(meta_list.count).toBe(2);
		});

		it("records snapshot_put with content_hash", async () => {
			const put_result = await corpus.stores.timelines.put({ items: [] });
			if (!put_result.ok) return;

			const snapshot_put = events.find((e) => e.type === "snapshot_put") as Extract<
				CorpusEvent,
				{ type: "snapshot_put" }
			>;
			expect(snapshot_put).toBeDefined();
			expect(snapshot_put.content_hash).toBeString();
			expect(snapshot_put.store_id).toBe("timelines");
			expect(snapshot_put.version).toBe(put_result.value.version);
		});
	});

	describe("invoked_at metadata", () => {
		it("stores invoked_at timestamp", async () => {
			const invoked = new Date("2024-01-15T10:00:00Z");

			const result = await corpus.stores.timelines.put(
				{ items: [] },
				{
					invoked_at: invoked,
				},
			);

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.invoked_at).toEqual(invoked);
		});
	});
});
