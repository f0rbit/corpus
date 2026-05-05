import { describe, test, expect } from "bun:test";
import { gzip_codec } from "../../codecs/gzip";
import { compose, text_codec, stream_to_bytes } from "../../utils";

describe("gzip_codec", () => {
	test("encode/decode roundtrip preserves bytes for small, medium, and 1 MB payloads", async () => {
		const codec = gzip_codec();

		const small = new TextEncoder().encode("hello gzip");
		const medium = new TextEncoder().encode("x".repeat(4096));
		const large = new Uint8Array(1024 * 1024);
		for (let i = 0; i < large.length; i++) large[i] = i & 0xff;

		for (const payload of [small, medium, large]) {
			const encoded = await codec.encode(payload);
			const decoded = await codec.decode(encoded);
			expect(decoded).toEqual(payload);
		}
	});

	test("encode produces gzip magic-header bytes (0x1f 0x8b)", async () => {
		const codec = gzip_codec();
		const out = await codec.encode(new TextEncoder().encode("anything"));
		expect(out[0]).toBe(0x1f);
		expect(out[1]).toBe(0x8b);
	});

	test("decode_stream decompresses a stream of gzip-encoded bytes", async () => {
		const codec = gzip_codec();
		const original = new TextEncoder().encode("streamed gzip payload — chunked decode");
		const compressed = await codec.encode(original);

		const input_stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(compressed);
				controller.close();
			},
		});

		const out = await stream_to_bytes(codec.decode_stream!(input_stream));
		expect(out).toEqual(original);
	});

	test("compose(text_codec, gzip_codec) compresses repeated input meaningfully smaller than the source", async () => {
		const codec = compose(text_codec(), gzip_codec());
		const input = "abcdefgh".repeat(1024); // 8 KB highly compressible
		const encoded = await codec.encode(input);

		expect(encoded.length).toBeLessThan(input.length / 4);

		const decoded = await codec.decode(encoded);
		expect(decoded).toBe(input);
	});

	test("compose(text_codec, gzip_codec).decode_stream is defined (structural streamability)", () => {
		const codec = compose(text_codec(), gzip_codec());
		expect(typeof codec.decode_stream).toBe("function");
		expect(typeof codec.encode_stream).toBe("function");
	});
});
