/**
 * @module Codecs / Gzip
 * @description Gzip byte-transformer codec via WebCrypto `CompressionStream`.
 */

import type { BytesCodec } from "../types.js";

/**
 * Creates a gzip byte-transformer codec.
 *
 * Encodes (compresses) and decodes (decompresses) `Uint8Array` payloads via
 * the standard `CompressionStream` / `DecompressionStream` APIs (available on
 * Workers, Bun, and Node 18+ — no polyfill required).
 *
 * Use as a layer in `compose(...)` — the head codec defines the value type;
 * `gzip_codec()` simply transforms the bytes left by an upstream encoder.
 *
 * Both `encode_stream` and `decode_stream` are present, so dropping
 * `gzip_codec()` into a composition preserves streamability iff the head
 * codec also has `decode_stream` (e.g. `text_codec()`, `binary_codec()`).
 *
 * @category Codecs
 * @group Codec Factories
 * @returns A `BytesCodec` that compresses on encode and decompresses on decode
 *
 * @example
 * ```ts
 * import { compose, json_codec, gzip_codec } from '@f0rbit/corpus'
 *
 * const codec = compose(json_codec(EventSchema), gzip_codec())
 * const events = define_store('events', codec)
 * ```
 */
export function gzip_codec(): BytesCodec {
	return {
		content_type: "application/gzip",
		async encode(bytes) {
			const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		},
		async decode(bytes) {
			const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
			return new Uint8Array(await new Response(stream).arrayBuffer());
		},
		encode_stream(value) {
			return new Blob([value as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
		},
		decode_stream(input) {
			return input.pipeThrough(
				new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
			);
		},
	};
}
