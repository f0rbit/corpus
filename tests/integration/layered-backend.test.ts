import { describe, it, expect, beforeEach } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	create_layered_backend,
	define_store,
	define_observation_type,
	json_codec,
	type Corpus,
	type Store,
	type Backend,
	type SnapshotMeta,
} from "../../index.js";

const item_schema = z.object({
	id: z.string(),
	text: z.string(),
});

type Item = z.infer<typeof item_schema>;

const obs = (backend: Backend) => {
	if (!backend.observations) throw new Error("backend has no observations client");
	return backend.observations;
};

const collect = async (backend: Backend) => {
	const rows = [];
	for await (const row of obs(backend).query()) rows.push(row);
	return rows;
};

describe("layered backend", () => {
	let memory1: Backend;
	let memory2: Backend;
	let write_only: Backend;
	let corpus: Corpus<{ items: Store<Item> }>;

	beforeEach(() => {
		memory1 = create_memory_backend();
		memory2 = create_memory_backend();
		write_only = create_memory_backend();
	});

	describe("read fallback", () => {
		it("returns from first backend when present", async () => {
			await memory1.metadata.put(make_meta("items", "v1", new Date("2024-01-01")));
			await memory1.data.put("items/v1", new TextEncoder().encode("first"));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const meta_result = await layered.metadata.get("items", "v1");
			expect(meta_result.ok).toBe(true);
			if (!meta_result.ok) return;
			expect(meta_result.value.version).toBe("v1");

			const data_result = await layered.data.get("items/v1");
			expect(data_result.ok).toBe(true);
			if (!data_result.ok) return;
			expect(await data_result.value.bytes()).toEqual(new TextEncoder().encode("first"));
		});

		it("falls back to second backend when first returns not_found", async () => {
			await memory2.metadata.put(make_meta("items", "v2", new Date("2024-01-02")));
			await memory2.data.put("items/v2", new TextEncoder().encode("second"));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const meta_result = await layered.metadata.get("items", "v2");
			expect(meta_result.ok).toBe(true);
			if (!meta_result.ok) return;
			expect(meta_result.value.version).toBe("v2");

			const data_result = await layered.data.get("items/v2");
			expect(data_result.ok).toBe(true);
		});

		it("returns not_found when no backend has the item", async () => {
			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.get("items", "missing");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});

		it("returns not_found when read array is empty", async () => {
			const layered = create_layered_backend({
				read: [],
				write: [],
			});

			const result = await layered.metadata.get("items", "any");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});
	});

	describe("write behavior", () => {
		it("writes only to write backends", async () => {
			const layered = create_layered_backend({
				read: [memory1],
				write: [write_only],
			});

			const meta = make_meta("items", "v1", new Date());
			await layered.metadata.put(meta);
			await layered.data.put("items/v1", new TextEncoder().encode("data"));

			const in_read = await memory1.metadata.get("items", "v1");
			expect(in_read.ok).toBe(false);

			const in_write = await write_only.metadata.get("items", "v1");
			expect(in_write.ok).toBe(true);
		});

		it("writes to all write backends", async () => {
			const layered = create_layered_backend({
				read: [],
				write: [memory1, memory2],
			});

			const meta = make_meta("items", "v1", new Date());
			await layered.metadata.put(meta);
			await layered.data.put("items/v1", new TextEncoder().encode("data"));

			const in_first = await memory1.metadata.get("items", "v1");
			const in_second = await memory2.metadata.get("items", "v1");
			expect(in_first.ok).toBe(true);
			expect(in_second.ok).toBe(true);
		});

		it("no-ops when write array is empty", async () => {
			const layered = create_layered_backend({
				read: [memory1],
				write: [],
			});

			const meta = make_meta("items", "v1", new Date());
			const result = await layered.metadata.put(meta);
			expect(result.ok).toBe(true);

			const data_result = await layered.data.put("items/v1", new TextEncoder().encode("data"));
			expect(data_result.ok).toBe(true);
		});

		it("buffers stream data when writing to multiple backends", async () => {
			const layered = create_layered_backend({
				read: [],
				write: [memory1, memory2],
			});

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("chunk1"));
					controller.enqueue(new TextEncoder().encode("chunk2"));
					controller.close();
				},
			});

			await layered.data.put("items/streamed", stream);

			const result1 = await memory1.data.get("items/streamed");
			const result2 = await memory2.data.get("items/streamed");

			expect(result1.ok).toBe(true);
			expect(result2.ok).toBe(true);
			if (!result1.ok || !result2.ok) return;

			const bytes1 = await result1.value.bytes();
			const bytes2 = await result2.value.bytes();
			expect(bytes1).toEqual(new TextEncoder().encode("chunk1chunk2"));
			expect(bytes2).toEqual(new TextEncoder().encode("chunk1chunk2"));
		});
	});

	describe("list merging", () => {
		it("merges layers: first layer wins on duplicates, newest first, limit after the merge", async () => {
			await fc.assert(
				fc.asyncProperty(layers_arb, limit_arb, async (layer_versions, limit) => {
					const backends = layer_versions.map(() => create_memory_backend());
					for (const [layer, versions] of layer_versions.entries()) {
						for (const version of versions) {
							await backends[layer]?.metadata.put({
								...make_meta("items", version, date_of(version)),
								size_bytes: layer,
							});
						}
					}

					const layered = create_layered_backend({ read: backends, write: [], list_strategy: "merge" });
					const actual: string[] = [];
					for await (const meta of layered.metadata.list("items", limit === undefined ? undefined : { limit })) {
						actual.push(`${meta.version}@${String(meta.size_bytes)}`);
					}

					expect(actual).toEqual(expected_merge(layer_versions, limit));
				}),
				{ numRuns: 200 },
			);
		});

		it("uses first strategy when configured", async () => {
			await memory1.metadata.put(make_meta("items", "v1", new Date("2024-01-01")));
			await memory2.metadata.put(make_meta("items", "v2", new Date("2024-01-02")));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
				list_strategy: "first",
			});

			const versions: string[] = [];
			for await (const meta of layered.metadata.list("items")) {
				versions.push(meta.version);
			}

			expect(versions).toHaveLength(1);
			expect(versions[0]).toBe("v1");
		});
	});

	describe("get_latest", () => {
		it("returns newest across all read backends", async () => {
			await memory1.metadata.put(make_meta("items", "v1", new Date("2024-01-01")));
			await memory2.metadata.put(make_meta("items", "v2", new Date("2024-01-03")));
			await memory1.metadata.put(make_meta("items", "v3", new Date("2024-01-02")));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.get_latest("items");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.version).toBe("v2");
		});

		it("returns not_found when no backends have data", async () => {
			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.get_latest("items");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});

		it("handles one backend with data and one without", async () => {
			await memory2.metadata.put(make_meta("items", "v1", new Date("2024-01-01")));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.get_latest("items");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.version).toBe("v1");
		});
	});

	describe("exists", () => {
		it("returns true if any read backend has the item", async () => {
			await memory2.data.put("items/v1", new TextEncoder().encode("data"));

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const exists = await layered.data.exists("items/v1");
			expect(exists).toBe(true);
		});

		it("returns false if no read backend has the item", async () => {
			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const exists = await layered.data.exists("items/missing");
			expect(exists).toBe(false);
		});
	});

	describe("delete behavior", () => {
		it("deletes from all write backends", async () => {
			await memory1.metadata.put(make_meta("items", "v1", new Date()));
			await memory2.metadata.put(make_meta("items", "v1", new Date()));

			const layered = create_layered_backend({
				read: [],
				write: [memory1, memory2],
			});

			const result = await layered.metadata.delete("items", "v1");
			expect(result.ok).toBe(true);

			const in_first = await memory1.metadata.get("items", "v1");
			const in_second = await memory2.metadata.get("items", "v1");
			expect(in_first.ok).toBe(false);
			expect(in_second.ok).toBe(false);
		});

		it("ignores not_found errors on delete", async () => {
			const layered = create_layered_backend({
				read: [],
				write: [memory1, memory2],
			});

			const result = await layered.metadata.delete("items", "nonexistent");
			expect(result.ok).toBe(true);
		});
	});

	describe("get_children", () => {
		it("merges children from all read backends", async () => {
			const parent = make_meta("items", "parent", new Date("2024-01-01"));
			await memory1.metadata.put(parent);

			const child1 = make_meta("items", "child1", new Date("2024-01-02"));
			child1.parents = [{ store_id: "items", version: "parent" }];
			await memory1.metadata.put(child1);

			const child2 = make_meta("items", "child2", new Date("2024-01-03"));
			child2.parents = [{ store_id: "items", version: "parent" }];
			await memory2.metadata.put(child2);

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const children: string[] = [];
			for await (const meta of layered.metadata.get_children("items", "parent")) {
				children.push(meta.version);
			}

			expect(children).toHaveLength(2);
			expect(children).toContain("child1");
			expect(children).toContain("child2");
		});

		it("deduplicates children by store_id:version", async () => {
			const child = make_meta("items", "child1", new Date("2024-01-02"));
			child.parents = [{ store_id: "items", version: "parent" }];
			await memory1.metadata.put(child);
			await memory2.metadata.put(child);

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const children: string[] = [];
			for await (const meta of layered.metadata.get_children("items", "parent")) {
				children.push(meta.version);
			}

			expect(children).toHaveLength(1);
		});
	});

	describe("find_by_hash", () => {
		it("finds in first backend with match", async () => {
			const meta = make_meta("items", "v1", new Date());
			meta.content_hash = "abc123";
			await memory1.metadata.put(meta);

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.find_by_hash("items", "abc123");
			expect(result).not.toBeNull();
			expect(result?.version).toBe("v1");
		});

		it("falls back to second backend", async () => {
			const meta = make_meta("items", "v1", new Date());
			meta.content_hash = "abc123";
			await memory2.metadata.put(meta);

			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.find_by_hash("items", "abc123");
			expect(result).not.toBeNull();
			expect(result?.version).toBe("v1");
		});

		it("returns null when no backend has match", async () => {
			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [],
			});

			const result = await layered.metadata.find_by_hash("items", "nonexistent");
			expect(result).toBeNull();
		});
	});

	describe("integration with corpus", () => {
		it("works with corpus builder", async () => {
			const layered = create_layered_backend({
				read: [memory1, memory2],
				write: [memory1],
			});

			corpus = create_corpus()
				.with_backend(layered)
				.with_store(define_store("items", json_codec(item_schema)))
				.build();

			const put_result = await corpus.stores.items.put({ id: "1", text: "hello" });
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			const get_result = await corpus.stores.items.get(put_result.value.version);
			expect(get_result.ok).toBe(true);
			if (!get_result.ok) return;
			expect(get_result.value.data).toEqual({ id: "1", text: "hello" });
		});
	});

	describe("observations", () => {
		const note_type = define_observation_type("note", z.object({ text: z.string() }));
		const source = { store_id: "items", version: "v1" };
		let cache: Backend;
		let disk: Backend;
		let layered: Backend;

		beforeEach(() => {
			cache = create_memory_backend();
			disk = create_memory_backend();
			layered = create_layered_backend({ read: [cache, disk], write: [cache, disk] });
		});

		it("put is readable through the layered get and stored under one id on both layers", async () => {
			const put = await obs(layered).put(note_type, { source, content: { text: "hi" } });
			expect(put.ok).toBe(true);
			if (!put.ok) return;

			const via_layered = await obs(layered).get(put.value.id);
			expect(via_layered.ok).toBe(true);
			expect((await obs(cache).get(put.value.id)).ok).toBe(true);
			expect((await obs(disk).get(put.value.id)).ok).toBe(true);
		});

		it("honours a caller-supplied id on both layers", async () => {
			const put = await obs(layered).put(note_type, { source, content: { text: "hi" }, id: "obs_mine" });
			expect(put.ok).toBe(true);
			if (!put.ok) return;
			expect(put.value.id).toBe("obs_mine");
			expect((await obs(cache).get("obs_mine")).ok).toBe(true);
			expect((await obs(disk).get("obs_mine")).ok).toBe(true);
		});

		it("delete removes the observation from both layers", async () => {
			const put = await obs(layered).put(note_type, { source, content: { text: "hi" } });
			if (!put.ok) throw new Error("put failed");

			const deleted = await obs(layered).delete(put.value.id);
			expect(deleted.ok).toBe(true);
			expect((await obs(cache).get(put.value.id)).ok).toBe(false);
			expect((await obs(disk).get(put.value.id)).ok).toBe(false);

			expect(await collect(layered)).toHaveLength(0);
		});

		it("delete of an unknown id is observation_not_found", async () => {
			const deleted = await obs(layered).delete("obs_missing");
			expect(deleted.ok).toBe(false);
			if (!deleted.ok) expect(deleted.error.kind).toBe("observation_not_found");
		});

		it("delete_by_source reports the real count, not one per layer", async () => {
			await obs(layered).put(note_type, { source, content: { text: "a" } });
			await obs(layered).put(note_type, { source, content: { text: "b" } });

			const removed = await obs(layered).delete_by_source(source);
			expect(removed.ok).toBe(true);
			if (removed.ok) expect(removed.value).toBe(2);
			expect(await collect(cache)).toHaveLength(0);
			expect(await collect(disk)).toHaveLength(0);
		});

		it("a collision on a later layer leaves earlier layers clean", async () => {
			const seeded = await obs(disk).put(note_type, { source, content: { text: "old" }, id: "obs_dup" });
			expect(seeded.ok).toBe(true);

			const put = await obs(layered).put(note_type, { source, content: { text: "new" }, id: "obs_dup" });
			expect(put.ok).toBe(false);
			if (!put.ok) expect(put.error.kind).toBe("validation_error");
			expect((await obs(cache).get("obs_dup")).ok).toBe(false);
		});
	});
});

const VERSION_POOL = ["v1", "v2", "v3", "v4", "v5", "v6"];

// a version carries the same created_at in every layer (3 distinct dates, so ties occur); duplicates differ only by
// the layer that holds them
const date_of = (version: string): Date => new Date(Date.UTC(2024, 0, 1 + (VERSION_POOL.indexOf(version) % 3)));

const layers_arb = fc.array(fc.uniqueArray(fc.constantFrom(...VERSION_POOL), { maxLength: 6 }), {
	minLength: 2,
	maxLength: 3,
});
const limit_arb = fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined });

// union of layers, first layer wins a duplicate; each layer lists newest-put first, so equal created_at keeps
// layer order then reverse insertion; limit applies to the merged result
function expected_merge(layer_versions: string[][], limit: number | undefined): string[] {
	const claimed = new Set<string>();
	const merged = layer_versions.flatMap((versions, layer) => {
		const fresh = versions.toReversed().filter((version) => !claimed.has(version));
		fresh.forEach((version) => claimed.add(version));
		return fresh.map((version) => ({ version, layer }));
	});
	return merged
		.toSorted((a, b) => date_of(b.version).getTime() - date_of(a.version).getTime())
		.slice(0, limit ?? Infinity)
		.map(({ version, layer }) => `${version}@${String(layer)}`);
}

function make_meta(store_id: string, version: string, created_at: Date): SnapshotMeta {
	return {
		store_id,
		version,
		parents: [],
		created_at,
		content_hash: `hash_${version}`,
		content_type: "application/json",
		size_bytes: 0,
		data_key: `${store_id}/${version}`,
	};
}
