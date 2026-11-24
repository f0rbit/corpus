import type { MutationManifest } from "./types.js";

const utils = "utils.ts";

export const manifest = {
	cluster: "codecs",
	old_tests: [
		"tests/unit/gzip.test.ts",
		"tests/unit/encrypt.test.ts",
		"tests/unit/codecs.test.ts",
		"tests/unit/compose.test.ts",
		"tests/integration/composed-codec.test.ts",
	],
	new_tests: ["tests/property/codec-laws.test.ts", "tests/integration/codecs.test.ts"],
	mutations: [
		{
			id: "codecs/compose-decode-not-reversed",
			file: utils,
			find: "for (const layer of layers.toReversed()) bytes = await layer.decode(bytes);",
			replace: "for (const layer of layers) bytes = await layer.decode(bytes);",
			guards: "compose decode unwinds layers right-to-left",
		},
		{
			id: "codecs/compose-decode-stream-not-reversed",
			file: utils,
			find: "for (const layer_fn of layer_decoders.toReversed()) bytes_stream = layer_fn(bytes_stream);",
			replace: "for (const layer_fn of layer_decoders) bytes_stream = layer_fn(bytes_stream);",
			guards: "compose decode_stream unwinds layers right-to-left",
		},
		{
			id: "codecs/compose-decode-stream-always-present",
			file: utils,
			find: "if (head_decode_stream && layer_decoders.length === layers.length) {",
			replace: "if (head_decode_stream && true) {",
			guards: "decode_stream exists only when every layer streams (encrypt disables it)",
		},
		{
			id: "codecs/text-decode-stream-per-chunk",
			file: utils,
			find: "bytes.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>),",
			replace:
				"bytes.pipeThrough(\n\t\t\t\tnew TransformStream<Uint8Array, string>({\n\t\t\t\t\ttransform(chunk, controller) {\n\t\t\t\t\t\tcontroller.enqueue(new TextDecoder().decode(chunk));\n\t\t\t\t\t},\n\t\t\t\t}),\n\t\t\t),",
			guards: "text decode_stream keeps decoder state across chunks split inside multi-byte characters",
		},
		{
			id: "codecs/binary-decode-stream-drops-last-chunk",
			file: utils,
			find: "decode_stream: (bytes) => bytes,",
			replace:
				"decode_stream: (bytes) => {\n\t\t\tlet held: Uint8Array | undefined;\n\t\t\treturn bytes.pipeThrough(\n\t\t\t\tnew TransformStream<Uint8Array, Uint8Array>({\n\t\t\t\t\ttransform(chunk, controller) {\n\t\t\t\t\t\tif (held) controller.enqueue(held);\n\t\t\t\t\t\theld = chunk;\n\t\t\t\t\t},\n\t\t\t\t}),\n\t\t\t);\n\t\t},",
			guards: "binary decode_stream emits every chunk including the last",
		},
		{
			id: "codecs/encrypt-fixed-zero-iv",
			file: "codecs/encrypt.ts",
			find: "const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));",
			replace: "const iv = new Uint8Array(IV_LENGTH);",
			guards: "encrypt uses a fresh random IV per encode",
		},
		{
			id: "codecs/encrypt-wrong-iv-slice",
			file: "codecs/encrypt.ts",
			find: "const iv = bytes.slice(0, IV_LENGTH);",
			replace: "const iv = bytes.slice(1, IV_LENGTH + 1);",
			guards: "decrypt reads the IV from the first 12 bytes",
		},
		{
			id: "codecs/gzip-encode-stream-decompresses",
			file: "codecs/gzip.ts",
			find: 'return new Blob([value as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));',
			replace:
				'return new Blob([value as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));',
			guards: "gzip encode_stream compresses",
		},
	],
} satisfies MutationManifest;
