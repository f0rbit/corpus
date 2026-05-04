import { describe, test, expect } from "bun:test";
import { compose, text_codec, binary_codec, json_codec, stream_to_bytes } from "../../utils";
import type { BytesCodec, Codec } from "../../types";

const passthrough_codec = (): BytesCodec => ({
	content_type: "application/octet-stream",
	encode: async (bytes) => bytes,
	decode: async (bytes) => bytes,
	encode_stream: (value) => new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(value)
			controller.close()
		}
	}),
	decode_stream: (stream) => stream,
});

const xor_layer = (mask = 0xff): BytesCodec => {
	const apply = (bytes: Uint8Array) => {
		const out = new Uint8Array(bytes.length);
		for (let i = 0; i < bytes.length; i++) out[i] = bytes[i]! ^ mask;
		return out;
	};
	return {
		content_type: "application/octet-stream",
		encode: async (bytes) => apply(bytes),
		decode: async (bytes) => apply(bytes),
	};
};

const failing_decode_layer = (message = "boom"): BytesCodec => ({
	content_type: "application/octet-stream",
	encode: async (bytes) => bytes,
	decode: async () => { throw new Error(message); },
});

describe("compose", () => {
	test("encode order produces same bytes as head alone for an identity layer", async () => {
		const head = text_codec();
		const composed = compose(head, passthrough_codec());

		const head_bytes = await head.encode("hello world");
		const composed_bytes = await composed.encode("hello world");

		expect(composed_bytes).toEqual(head_bytes);
	});

	test("decode roundtrip with identity layer matches input", async () => {
		const composed = compose(text_codec(), passthrough_codec());
		const bytes = await composed.encode("roundtrip test");
		const decoded = await composed.decode(bytes);
		expect(decoded).toBe("roundtrip test");
	});

	test("xor layer roundtrip recovers original value through compose", async () => {
		const composed = compose(text_codec(), xor_layer(0xff));
		const original = "hello";
		const encoded = await composed.encode(original);

		// xor layer must have actually transformed the bytes
		const head_bytes = await text_codec().encode(original);
		expect(encoded).not.toEqual(head_bytes);

		const decoded = await composed.decode(encoded);
		expect(decoded).toBe(original);
	});

	test("streamability inference: all-streamable layers expose decode_stream; non-streamable head does not", () => {
		const streamable = compose(text_codec(), passthrough_codec());
		expect(typeof streamable.decode_stream).toBe("function");
		expect(typeof streamable.encode_stream).toBe("function");

		const Schema = { parse: (x: unknown) => x as { id: string } };
		const non_streamable = compose(json_codec<{ id: string }>(Schema), passthrough_codec());
		expect(non_streamable.decode_stream).toBeUndefined();
		expect(non_streamable.encode_stream).toBeUndefined();
	});

	test("error in a layer's decode propagates to composed decode", async () => {
		const composed = compose(text_codec(), failing_decode_layer("layer-failed"));
		const bytes = await composed.encode("x");

		expect(composed.decode(bytes)).rejects.toThrow("layer-failed");
	});

	test("compose with zero layers returns the head codec unchanged", () => {
		const head = text_codec();
		const composed = compose(head);
		expect(composed).toBe(head as unknown as Codec<string>);
	});

	test("decode_stream pipes through layers in reverse order", async () => {
		const composed = compose(text_codec(), passthrough_codec());
		const bytes = await composed.encode("streamed");

		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			}
		});

		const out_stream = composed.decode_stream!(input);
		const reader = out_stream.getReader();
		let result = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += value;
		}
		expect(result).toBe("streamed");
	});

	test("encode_stream produces same bytes as encode when concatenated", async () => {
		const composed = compose(binary_codec(), passthrough_codec());
		const value = new Uint8Array([1, 2, 3, 4, 5]);

		const buffered = await composed.encode(value);
		const streamed = await stream_to_bytes(composed.encode_stream!(value));

		expect(streamed).toEqual(buffered);
	});
});
