import { describe, it, expect, beforeAll } from "bun:test";
import { z } from "zod";
import { create_corpus, create_memory_backend, define_store, json_codec, compose } from "../../index";
import { gzip_codec } from "../../codecs/gzip";
import { encrypt_codec } from "../../codecs/encrypt";

const EventSchema = z.object({
	id: z.string(),
	timestamp: z.number(),
	payload: z.string(),
});

const make_key = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

describe("composed codec integration", () => {
	describe("compose(json_codec, gzip_codec)", () => {
		it("roundtrips through memory backend", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("events", compose(json_codec(EventSchema), gzip_codec())))
				.build();

			const event = { id: "evt-1", timestamp: 123, payload: "x".repeat(512) };
			const put = await corpus.stores.events.put(event);
			expect(put.ok).toBe(true);
			if (!put.ok) return;

			const get = await corpus.stores.events.get(put.value.version);
			expect(get.ok).toBe(true);
			if (!get.ok) return;

			expect(get.value.data).toEqual(event);
		});

		it("deduplicates: storing the same value twice produces matching content_hash", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("events", compose(json_codec(EventSchema), gzip_codec())))
				.build();

			const event = { id: "evt-dup", timestamp: 42, payload: "stable" };
			const a = await corpus.stores.events.put(event);
			const b = await corpus.stores.events.put(event);
			expect(a.ok && b.ok).toBe(true);
			if (!a.ok || !b.ok) return;

			expect(a.value.content_hash).toBe(b.value.content_hash);
			expect(a.value.data_key).toBe(b.value.data_key);
		});
	});

	describe("compose(json_codec, gzip_codec, encrypt_codec)", () => {
		let key: CryptoKey;

		beforeAll(async () => {
			key = await make_key();
		});

		it("roundtrips through memory backend", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("secrets", compose(json_codec(EventSchema), gzip_codec(), encrypt_codec(key))))
				.build();

			const event = { id: "secret-1", timestamp: 999, payload: "top secret" };
			const put = await corpus.stores.secrets.put(event);
			expect(put.ok).toBe(true);
			if (!put.ok) return;

			const get = await corpus.stores.secrets.get(put.value.version);
			expect(get.ok).toBe(true);
			if (!get.ok) return;

			expect(get.value.data).toEqual(event);
		});

		it("does NOT deduplicate: random IV per encode means identical plaintexts produce different content_hashes", async () => {
			const corpus = create_corpus()
				.with_backend(create_memory_backend())
				.with_store(define_store("secrets", compose(json_codec(EventSchema), gzip_codec(), encrypt_codec(key))))
				.build();

			const event = { id: "secret-dup", timestamp: 7, payload: "same" };
			const a = await corpus.stores.secrets.put(event);
			const b = await corpus.stores.secrets.put(event);
			expect(a.ok && b.ok).toBe(true);
			if (!a.ok || !b.ok) return;

			expect(a.value.content_hash).not.toBe(b.value.content_hash);
			expect(a.value.data_key).not.toBe(b.value.data_key);
		});
	});
});
