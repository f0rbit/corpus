import { describe, test, expect } from "bun:test";
import { text_codec, binary_codec, json_codec, stream_to_bytes, concat_bytes } from "../../utils.js";

const collect_strings = async (stream: ReadableStream<string>): Promise<string[]> => {
	const reader = stream.getReader();
	const chunks: string[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
};

describe("Built-in codec stream methods", () => {
	test("text_codec.encode_stream produces UTF-8 bytes equal to encode(full_string)", async () => {
		const codec = text_codec();
		const input = "hello stream world — with non-ASCII éé";

		const buffered = await codec.encode(input);
		const streamed = await stream_to_bytes(codec.encode_stream!(input));

		expect(streamed).toEqual(buffered);
	});

	test("text_codec.decode_stream concatenated equals decode(full_bytes)", async () => {
		const codec = text_codec();
		const input = "chunked decode test";
		const bytes = await codec.encode(input);

		// split into two chunks to actually exercise the streaming decoder
		const half = Math.floor(bytes.length / 2);
		const chunk_a = bytes.slice(0, half);
		const chunk_b = bytes.slice(half);

		const byte_stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk_a);
				controller.enqueue(chunk_b);
				controller.close();
			},
		});

		const out_chunks = await collect_strings(codec.decode_stream!(byte_stream));
		expect(out_chunks.join("")).toBe(await codec.decode(bytes));
	});

	test("binary_codec.encode_stream is passthrough — chunks come out byte-identical", async () => {
		const codec = binary_codec();
		const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

		const out = await stream_to_bytes(codec.encode_stream!(input));
		expect(out).toEqual(input);
	});

	test("binary_codec.decode_stream is passthrough", async () => {
		const codec = binary_codec();
		const chunk_a = new Uint8Array([1, 2, 3]);
		const chunk_b = new Uint8Array([4, 5, 6]);

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk_a);
				controller.enqueue(chunk_b);
				controller.close();
			},
		});

		const decoded = codec.decode_stream!(stream);
		const collected: Uint8Array[] = [];
		const reader = decoded.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			collected.push(value);
		}

		expect(collected.length).toBe(2);
		expect(concat_bytes(collected)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
	});

	test("json_codec exposes neither encode_stream nor decode_stream", () => {
		const schema = { parse: (x: unknown) => x as { id: string } };
		const codec = json_codec<{ id: string }>(schema);
		expect(codec.decode_stream).toBeUndefined();
		expect(codec.encode_stream).toBeUndefined();
	});
});
