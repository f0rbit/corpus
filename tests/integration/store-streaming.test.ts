import { describe, it, expect } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	text_codec,
	binary_codec,
	compute_hash,
} from "../../index";
import { create_file_backend } from "../../backend/file";
import type { Codec } from "../../types";

const drain_chunks = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
	const reader = stream.getReader();
	const chunks: T[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
};

describe("store streaming", () => {
	describe("get_handle / get_latest_handle", () => {
		it("put + get_handle roundtrip exposes value(), bytes(), and stream()", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("notes", text_codec()))
				.build();

			const text = "hello, streaming world";
			const put_result = await corpus.stores.notes.put(text);
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			const handle_result = await corpus.stores.notes.get_handle(put_result.value.version);
			expect(handle_result.ok).toBe(true);
			if (!handle_result.ok) return;

			const { meta, handle } = handle_result.value;
			expect(meta.version).toBe(put_result.value.version);

			const value_result = await handle.value();
			expect(value_result.ok).toBe(true);
			if (!value_result.ok) return;
			expect(value_result.value).toBe(text);

			const bytes_result = await handle.bytes();
			expect(bytes_result.ok).toBe(true);
			if (!bytes_result.ok) return;
			expect(new TextDecoder().decode(bytes_result.value)).toBe(text);

			const stream_result = await handle.stream();
			expect(stream_result.ok).toBe(true);
			if (!stream_result.ok) return;

			const chunks = await drain_chunks(stream_result.value);
			expect(chunks.join("")).toBe(text);
		});

		it("get_latest_handle returns the most recent snapshot", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("notes", text_codec()))
				.build();

			const first = await corpus.stores.notes.put("first");
			await new Promise((r) => setTimeout(r, 5));
			const second = await corpus.stores.notes.put("second");
			expect(first.ok && second.ok).toBe(true);
			if (!first.ok || !second.ok) return;

			const handle_result = await corpus.stores.notes.get_latest_handle();
			expect(handle_result.ok).toBe(true);
			if (!handle_result.ok) return;

			expect(handle_result.value.meta.version).toBe(second.value.version);

			const value_result = await handle_result.value.handle.value();
			expect(value_result.ok).toBe(true);
			if (!value_result.ok) return;
			expect(value_result.value).toBe("second");
		});

		it("stream() yields multiple chunks for a multi-chunk source", async () => {
			// File backend uses Bun.file().stream(), which emits 256 KB chunks. A 1 MB
			// payload guarantees ≥ 2 chunks and proves we're streaming, not buffering.
			const dir = join(tmpdir(), "corpus-store-streaming-test");
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			try {
				const corpus = create_corpus()
					.with_backend(create_file_backend({ base_path: dir }))
					.with_store(define_store("logs", text_codec()))
					.build();

				const big_text = "x".repeat(1024 * 1024);
				const put_result = await corpus.stores.logs.put(big_text);
				expect(put_result.ok).toBe(true);
				if (!put_result.ok) return;

				const handle_result = await corpus.stores.logs.get_handle(put_result.value.version);
				expect(handle_result.ok).toBe(true);
				if (!handle_result.ok) return;

				const stream_result = await handle_result.value.handle.stream();
				expect(stream_result.ok).toBe(true);
				if (!stream_result.ok) return;

				const chunks = await drain_chunks(stream_result.value);
				expect(chunks.length).toBeGreaterThanOrEqual(2);
				expect(chunks.join("")).toBe(big_text);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	});

	describe("put_stream", () => {
		it("roundtrips a multi-chunk text stream through text_codec", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("logs", text_codec()))
				.build();

			const parts = ["alpha\n", "beta\n", "gamma\n", "delta\n", "epsilon\n"];
			const stream = new ReadableStream<string>({
				start(controller) {
					for (const p of parts) controller.enqueue(p);
					controller.close();
				},
			});

			const put_result = await corpus.stores.logs.put_stream(stream);
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			const handle_result = await corpus.stores.logs.get_handle(put_result.value.version);
			expect(handle_result.ok).toBe(true);
			if (!handle_result.ok) return;

			const value_result = await handle_result.value.handle.value();
			expect(value_result.ok).toBe(true);
			if (!value_result.ok) return;
			expect(value_result.value).toBe(parts.join(""));
		});

		it("produces same content_hash as buffered put for identical content", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("logs", text_codec()))
				.build();

			const parts = ["one ", "two ", "three"];
			const buffered = parts.join("");

			const put_buf = await corpus.stores.logs.put(buffered);
			expect(put_buf.ok).toBe(true);
			if (!put_buf.ok) return;

			const stream = new ReadableStream<string>({
				start(controller) {
					for (const p of parts) controller.enqueue(p);
					controller.close();
				},
			});
			const put_stream = await corpus.stores.logs.put_stream(stream);
			expect(put_stream.ok).toBe(true);
			if (!put_stream.ok) return;

			expect(put_stream.value.content_hash).toBe(put_buf.value.content_hash);
			expect(put_stream.value.data_key).toBe(put_buf.value.data_key);

			// Sanity: matches compute_hash over the encoded full bytes.
			const encoded = new TextEncoder().encode(buffered);
			const expected = await compute_hash(encoded);
			expect(put_stream.value.content_hash).toBe(expected);
		});

		it("works with binary_codec on a multi-chunk Uint8Array stream", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("blobs", binary_codec()))
				.build();

			const a = new Uint8Array([1, 2, 3, 4]);
			const b = new Uint8Array([5, 6, 7, 8]);
			const c = new Uint8Array([9, 10]);

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(a);
					controller.enqueue(b);
					controller.enqueue(c);
					controller.close();
				},
			});

			const put_result = await corpus.stores.blobs.put_stream(stream);
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			const handle_result = await corpus.stores.blobs.get_handle(put_result.value.version);
			expect(handle_result.ok).toBe(true);
			if (!handle_result.ok) return;

			const value_result = await handle_result.value.handle.value();
			expect(value_result.ok).toBe(true);
			if (!value_result.ok) return;

			expect(value_result.value).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
		});

		it("rejects when codec lacks encode_stream", async () => {
			// Construct a Codec<Uint8Array> with NO encode_stream / decode_stream.
			// This satisfies T extends StreamableValue at compile time so put_stream
			// is callable, but the runtime guard rejects it.
			const no_stream_codec: Codec<Uint8Array> = {
				content_type: "application/octet-stream",
				encode: async (v) => v,
				decode: async (b) => b,
			};

			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("raw", no_stream_codec))
				.build();

			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			});

			const result = await corpus.stores.raw.put_stream(stream);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("invalid_config");
		});
	});

	describe("type-level", () => {
		it("get_handle().handle.stream() is a type error on json_codec stores", async () => {
			const UserSchema = z.object({ name: z.string() });
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("users", json_codec(UserSchema)))
				.build();

			const put_result = await corpus.stores.users.put({ name: "Alice" });
			if (!put_result.ok) return;

			const handle_result = await corpus.stores.users.get_handle(put_result.value.version);
			if (!handle_result.ok) return;

			// Type-level assertion only — gated by `if (false)` so we never invoke
			// the (runtime-undefined) stream() at test time.
			if (false as boolean) {
				// @ts-expect-error — stream() is `never` on a non-StreamableValue T
				await handle_result.value.handle.stream();
			}

			// Sanity: value() and bytes() remain callable.
			const v = await handle_result.value.handle.value();
			expect(v.ok).toBe(true);
		});

		it("put_stream is a type error on json_codec stores", async () => {
			const UserSchema = z.object({ name: z.string() });
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("users", json_codec(UserSchema)))
				.build();

			const stream = new ReadableStream<{ name: string }>({
				start(controller) {
					controller.enqueue({ name: "Alice" });
					controller.close();
				},
			});

			if (false as boolean) {
				// @ts-expect-error — put_stream is `never` when T is not StreamableValue
				await corpus.stores.users.put_stream(stream);
			}

			// Sanity: the codec rejects a stream call would fail anyway, but we just
			// want this block to never execute. Reference variables to satisfy linters.
			expect(stream).toBeDefined();
		});
	});
});
