import { describe, it, expect } from "bun:test";
import { create_data_client } from "../../backend/base.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_corpus, define_store, text_codec } from "../../index.js";
import type { Backend, CorpusEvent } from "../../types.js";
import { create_throwing_data_storage, storage_failure, type ThrowMode } from "../fakes/throwing-data-storage.js";

const modes: ThrowMode[] = ["sync", "reject"];

describe.each(modes)("create_data_client over throwing storage (%s)", (mode) => {
	const make = () => {
		const events: CorpusEvent[] = [];
		const client = create_data_client(create_throwing_data_storage(mode), (e) => events.push(e));
		return { client, events };
	};

	it("get returns storage_error", async () => {
		const { client } = make();
		const result = await client.get("k");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("storage_error");
			if (result.error.kind === "storage_error") expect(result.error.operation).toBe("data.get");
		}
	});

	it("put returns storage_error for bytes and stream input", async () => {
		const { client } = make();
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array([1]));
				c.close();
			},
		});
		const results = await Promise.all([client.put("k", new Uint8Array([1])), client.put("k", stream)]);
		results.forEach((r) => {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.kind).toBe("storage_error");
		});
	});

	it("delete returns storage_error", async () => {
		const { client } = make();
		const result = await client.delete("k");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("storage_error");
	});

	it("exists resolves false and emits an error event instead of rejecting", async () => {
		const { client, events } = make();
		expect(await client.exists("k")).toBe(false);
		const failures = events.filter((e) => e.type === "error");
		expect(failures).toHaveLength(1);
	});

	it("store.put through a corpus returns err, not a rejection", async () => {
		const backend: Backend = {
			...create_memory_backend(),
			data: create_data_client(create_throwing_data_storage(mode), () => {}),
		};
		const corpus = create_corpus().with_backend(backend).with_store(define_store("notes", text_codec())).build();
		const result = await corpus.stores.notes.put("hello");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("storage_error");
	});
});

const make_corpus = async () => {
	const base = create_memory_backend();
	const seeded = create_corpus().with_backend(base).with_store(define_store("notes", text_codec())).build();
	const put = await seeded.stores.notes.put("hello");
	expect(put.ok).toBe(true);

	const events: CorpusEvent[] = [];
	const failing = create_data_client(
		{
			get: () => Promise.resolve({ bytes: () => Promise.reject(storage_failure) }),
			put: () => Promise.resolve(),
			delete: () => Promise.resolve(),
			exists: () => Promise.resolve(true),
		},
		(e) => events.push(e),
	);
	const backend: Backend = { ...base, data: failing };
	const corpus = create_corpus()
		.with_backend({ ...backend, on_event: (e) => events.push(e) })
		.with_store(define_store("notes", text_codec()))
		.build();
	return { corpus, events };
};

describe("handle byte reads that reject", () => {
	it("store.get returns storage_error instead of rejecting", async () => {
		const { corpus } = await make_corpus();
		const result = await corpus.stores.notes.get_latest();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("storage_error");
	});

	it("handle.bytes() and handle.value() return storage_error", async () => {
		const { corpus, events } = await make_corpus();
		const handle = await corpus.stores.notes.get_latest_handle();
		expect(handle.ok).toBe(true);
		if (!handle.ok) return;
		const [bytes, value] = await Promise.all([handle.value.handle.bytes(), handle.value.handle.value()]);
		for (const r of [bytes, value]) {
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.kind).toBe("storage_error");
		}
		expect(events.some((e) => e.type === "error")).toBe(true);
	});
});
