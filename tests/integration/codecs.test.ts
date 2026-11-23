import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { create_corpus, create_memory_backend, define_store, json_codec, compose } from "../../index.js";
import { gzip_codec } from "../../codecs/gzip.js";
import { encrypt_codec } from "../../codecs/encrypt.js";
import { binary_codec, concat_bytes, text_codec } from "../../utils.js";
import type { BytesCodec } from "../../types.js";

const make_key = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

const event_schema = z.object({
	id: z.string(),
	timestamp: z.number(),
	payload: z.string(),
});

const failing_decode_layer = (message: string): BytesCodec => ({
	content_type: "application/octet-stream",
	encode: async (bytes) => bytes,
	decode: async () => {
		throw new Error(message);
	},
});

const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
	const reader = stream.getReader();
	const out: Uint8Array[] = [];
	for (;;) {
		const read = await reader.read();
		if (read.done) return out;
		out.push(read.value);
	}
};

const encode_text = (text: string) => new TextEncoder().encode(text);

describe("encrypt_codec", () => {
	let key: CryptoKey;

	beforeAll(async () => {
		key = await make_key();
	});

	test("same plaintext encoded twice produces different ciphertexts (random IV)", async () => {
		const codec = encrypt_codec(key);
		const plaintext = encode_text("static plaintext");
		const a = await codec.encode(plaintext);
		const b = await codec.encode(plaintext);
		expect(a).not.toEqual(b);
	});

	test("decode with the wrong key fails", async () => {
		const ciphertext = await encrypt_codec(key).encode(encode_text("secret"));
		await expect(encrypt_codec(await make_key()).decode(ciphertext)).rejects.toThrow();
	});

	test("tampered ciphertext fails to decrypt (auth-tag verification)", async () => {
		const codec = encrypt_codec(key);
		const tampered = new Uint8Array(await codec.encode(encode_text("integrity check")));
		tampered[16] = (tampered[16] ?? 0) ^ 0x01;
		await expect(codec.decode(tampered)).rejects.toThrow();
	});
});

describe("gzip_codec", () => {
	test("encode output starts with the gzip magic bytes 0x1f 0x8b", async () => {
		const out = await gzip_codec().encode(encode_text("anything"));
		expect(out[0]).toBe(0x1f);
		expect(out[1]).toBe(0x8b);
	});

	test("compose(text_codec, gzip_codec) compresses repeated input meaningfully", async () => {
		const codec = compose(text_codec(), gzip_codec());
		const input = "abcdefgh".repeat(1024);
		const encoded = await codec.encode(input);
		expect(encoded.length).toBeLessThan(input.length / 4);
		expect(await codec.decode(encoded)).toBe(input);
	});
});

describe("compose", () => {
	test("an error in a layer's decode propagates to composed decode", async () => {
		const composed = compose(text_codec(), failing_decode_layer("layer-failed"));
		const bytes = await composed.encode("x");
		await expect(composed.decode(bytes)).rejects.toThrow("layer-failed");
	});

	test("zero layers returns the head codec unchanged", () => {
		const head = text_codec();
		expect(compose(head)).toBe(head);
	});
});

describe("multi-chunk decode_stream (>= 512 KB)", () => {
	const chunk_size = 64 * 1024;
	const payload = Uint8Array.from({ length: 640 * 1024 }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

	const split = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += chunk_size) {
					controller.enqueue(bytes.slice(offset, offset + chunk_size));
				}
				controller.close();
			},
		});

	test("binary_codec passes every chunk through intact", async () => {
		const chunks = await collect(binary_codec().decode_stream?.(split(payload)) ?? split(new Uint8Array()));
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(concat_bytes(chunks)).toEqual(payload);
	});

	test("compose(binary_codec, gzip_codec) decodes a chunked gzip stream to the original bytes", async () => {
		const codec = compose(binary_codec(), gzip_codec());
		const decode_stream = codec.decode_stream;
		if (!decode_stream) throw new Error("expected decode_stream");
		const compressed = await codec.encode(payload);
		const chunks = await collect(decode_stream(split(compressed)));
		expect(concat_bytes(chunks)).toEqual(payload);
	});
});

describe("composed codecs through the memory backend", () => {
	let key: CryptoKey;

	beforeAll(async () => {
		key = await make_key();
	});

	test("compose(json, gzip) deduplicates: identical values share content_hash and data_key", async () => {
		const corpus = create_corpus()
			.with_backend(create_memory_backend())
			.with_store(define_store("events", compose(json_codec(event_schema), gzip_codec())))
			.build();

		const event = { id: "evt-dup", timestamp: 42, payload: "stable" };
		const a = await corpus.stores.events.put(event);
		const b = await corpus.stores.events.put(event);
		if (!a.ok || !b.ok) throw new Error("put failed");

		expect(a.value.content_hash).toBe(b.value.content_hash);
		expect(a.value.data_key).toBe(b.value.data_key);
	});

	test("compose(json, gzip, encrypt) does NOT deduplicate (random IV)", async () => {
		const corpus = create_corpus()
			.with_backend(create_memory_backend())
			.with_store(define_store("secrets", compose(json_codec(event_schema), gzip_codec(), encrypt_codec(key))))
			.build();

		const event = { id: "secret-dup", timestamp: 7, payload: "same" };
		const a = await corpus.stores.secrets.put(event);
		const b = await corpus.stores.secrets.put(event);
		if (!a.ok || !b.ok) throw new Error("put failed");

		expect(a.value.content_hash).not.toBe(b.value.content_hash);
		expect(a.value.data_key).not.toBe(b.value.data_key);

		const got = await corpus.stores.secrets.get(a.value.version);
		if (!got.ok) throw new Error("get failed");
		expect(got.value.data).toEqual(event);
	});
});
