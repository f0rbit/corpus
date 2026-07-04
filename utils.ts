/**
 * @module Utilities
 * @description Utility functions for hashing, versioning, and codecs.
 */

import type {
	BytesCodec,
	Codec,
	CorpusEvent,
	EventHandler,
	SnapshotMeta,
	ListOpts,
	ParentRef,
	Parser,
} from "./types.js";

/**
 * Computes the SHA-256 hash of binary data.
 * @category Utilities
 * @group Hashing
 *
 * Returns a lowercase hexadecimal string (64 characters).
 * Used internally for content-addressable storage and deduplication.
 *
 * @param data - The binary data to hash
 * @returns A lowercase hex string of the SHA-256 hash
 *
 * @example
 * ```ts
 * const data = new TextEncoder().encode('Hello, world!')
 * const hash = await compute_hash(data)
 * // => '315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3'
 * ```
 */
export async function compute_hash(data: Uint8Array): Promise<string> {
	const hash_buffer = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
	const hash_array = new Uint8Array(hash_buffer);
	return Array.from(hash_array)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

let last_timestamp = 0;
let sequence = 0;

/**
 * Generates a unique, time-sortable version string.
 *
 * Format: base64url-encoded timestamp, with optional `.N` suffix when multiple
 * versions are generated within the same millisecond.
 *
 * Versions sort lexicographically in chronological order, making them suitable
 * for use as database keys where ordering matters.
 *
 * @category Utilities
 * @group Versioning
 * @returns A unique version string like `AZJx4vM` or `AZJx4vM.1`
 *
 * @example
 * ```ts
 * const v1 = generate_version() // => 'AZJx4vM'
 * const v2 = generate_version() // => 'AZJx4vM.1' (same millisecond)
 * const v3 = generate_version() // => 'AZJx4vN' (next millisecond)
 *
 * // Versions sort chronologically
 * [v3, v1, v2].sort() // => [v1, v2, v3]
 * ```
 */
export function generate_version(): string {
	const now = Date.now();

	if (now === last_timestamp) {
		sequence++;
	} else {
		last_timestamp = now;
		sequence = 0;
	}

	// base64url encode the timestamp (no padding, url-safe)
	const timestamp_bytes = new Uint8Array(8);
	const view = new DataView(timestamp_bytes.buffer);
	view.setBigUint64(0, BigInt(now), false); // big-endian for lexicographic sorting

	// trim leading zeros for compactness
	let start = 0;
	while (start < 7 && timestamp_bytes[start] === 0) start++;
	const trimmed = timestamp_bytes.slice(start);

	const base64 = btoa(String.fromCharCode(...trimmed))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	return sequence > 0 ? `${base64}.${String(sequence)}` : base64;
}

/**
 * Creates a JSON codec with schema validation.
 *
 * Data is serialized to JSON on encode and validated against the schema on decode.
 * Works with both Zod 3.x and 4.x (uses structural typing, not Zod imports).
 *
 * Note: Validation only happens on decode. Invalid data passed to encode will
 * serialize but may fail validation when decoded later.
 *
 * @category Codecs
 * @group Codec Factories
 * @param schema - A Zod schema (or any object with a `parse` method)
 * @returns A Codec for JSON serialization with validation
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 *
 * const UserSchema = z.object({
 *   id: z.string().uuid(),
 *   name: z.string(),
 *   createdAt: z.coerce.date()
 * })
 *
 * const codec = json_codec(UserSchema)
 * const users = define_store('users', codec)
 *
 * // Decoding validates and transforms data
 * const bytes = codec.encode({ id: '...', name: 'Alice', createdAt: '2024-01-01' })
 * const user = codec.decode(bytes) // createdAt is now a Date object
 * ```
 */
export function json_codec<T>(schema: Parser<T>): Codec<T> {
	return {
		content_type: "application/json",
		encode: async (value) => new TextEncoder().encode(JSON.stringify(value)),
		decode: async (bytes) => schema.parse(JSON.parse(new TextDecoder().decode(bytes))),
	};
}

/**
 * Creates a plain text codec using UTF-8 encoding.
 *
 * No validation is performed - any string can be encoded and any valid
 * UTF-8 bytes can be decoded.
 *
 * @category Codecs
 * @group Codec Factories
 * @returns A Codec for plain text strings
 *
 * @example
 * ```ts
 * const notes = define_store('notes', text_codec())
 *
 * await corpus.stores.notes.put('Meeting notes for 2024-01-15...')
 *
 * const result = await corpus.stores.notes.get_latest()
 * if (result.ok) {
 *   console.log(result.value.data) // string
 * }
 * ```
 */
export function text_codec(): Codec<string> {
	return {
		content_type: "text/plain",
		encode: async (value) => new TextEncoder().encode(value),
		decode: async (bytes) => new TextDecoder().decode(bytes),
		encode_stream: (value) => {
			const stream = new ReadableStream<string>({
				start(controller) {
					controller.enqueue(value);
					controller.close();
				},
			});
			return stream.pipeThrough(new TextEncoderStream());
		},
		decode_stream: (bytes) =>
			bytes.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>),
	};
}

/**
 * Creates a pass-through codec for raw binary data.
 *
 * No transformation is performed - bytes are stored and retrieved as-is.
 * Use for images, PDFs, pre-serialized data, or any binary content.
 *
 * @category Codecs
 * @group Codec Factories
 * @returns A Codec for raw binary data
 *
 * @example
 * ```ts
 * const images = define_store('images', binary_codec())
 *
 * // Store an image
 * const imageData = await fetch('photo.png').then(r => r.arrayBuffer())
 * await corpus.stores.images.put(new Uint8Array(imageData))
 *
 * // Store pre-serialized protobuf
 * const protoBytes = MyMessage.encode(message).finish()
 * await corpus.stores.images.put(protoBytes)
 * ```
 */
export function binary_codec(): Codec<Uint8Array> {
	return {
		content_type: "application/octet-stream",
		encode: async (value) => value,
		decode: async (bytes) => bytes,
		encode_stream: (value) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(value);
					controller.close();
				},
			}),
		decode_stream: (bytes) => bytes,
	};
}

/**
 * Compose a head codec with N byte-transforming layers (gzip, encrypt, base64, …).
 *
 * Encode runs left-to-right (`head.encode(v)` → `layers[0].encode(bytes)` → … → final bytes).
 * Decode runs right-to-left (final bytes → `layers[n-1].decode(bytes)` → … → `head.decode(bytes)`).
 *
 * `content_type` comes from the head — wrapper layers don't change semantic type.
 *
 * Streamability is structural: `encode_stream` / `decode_stream` are present on the
 * returned codec only when the head and every layer expose the corresponding stream
 * method. Dropping a non-streamable layer (e.g. an AEAD `decode`) into a composition
 * disables streaming for the whole pipeline.
 *
 * @category Codecs
 * @group Codec Combinators
 *
 * @example
 * ```ts
 * const codec = compose(json_codec(UserSchema), gzip_codec())
 * // codec.decode_stream is undefined — json_codec lacks decode_stream.
 *
 * const text_gz = compose(text_codec(), gzip_codec())
 * // text_gz.decode_stream is defined.
 * ```
 */
export function compose<T>(head: Codec<T>, ...layers: BytesCodec[]): Codec<T> {
	if (layers.length === 0) return head;

	const head_encode_stream = head.encode_stream;
	const head_decode_stream = head.decode_stream;
	const layer_encoders = layers.flatMap((l) => (l.encode_stream ? [l.encode_stream] : []));
	const layer_decoders = layers.flatMap((l) => (l.decode_stream ? [l.decode_stream] : []));

	const codec: Codec<T> = {
		content_type: head.content_type,
		async encode(value) {
			let bytes = await head.encode(value);
			for (const layer of layers) bytes = await layer.encode(bytes);
			return bytes;
		},
		async decode(bytes) {
			for (const layer of layers.toReversed()) bytes = await layer.decode(bytes);
			return head.decode(bytes);
		},
	};

	if (head_encode_stream && layer_encoders.length === layers.length) {
		codec.encode_stream = (value) => {
			let stream = head_encode_stream(value);
			for (const layer_fn of layer_encoders) {
				const layer_in = stream;
				stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						const buffered = await stream_to_bytes(layer_in);
						const layer_out = layer_fn(buffered);
						const reader = layer_out.getReader();
						for (;;) {
							const { done, value: chunk } = await reader.read();
							if (done) break;
							controller.enqueue(chunk);
						}
						controller.close();
					},
				});
			}
			return stream;
		};
	}

	if (head_decode_stream && layer_decoders.length === layers.length) {
		codec.decode_stream = (stream) => {
			let bytes_stream = stream;
			for (const layer_fn of layer_decoders.toReversed()) bytes_stream = layer_fn(bytes_stream);
			return head_decode_stream(bytes_stream);
		};
	}

	return codec;
}

/**
 * Concatenate multiple Uint8Array chunks into a single array.
 */
export function concat_bytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

/**
 * Read a stream into a single Uint8Array.
 */
export async function stream_to_bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return concat_bytes(chunks);
}

/**
 * Convert a stream or Uint8Array to Uint8Array.
 */
export async function to_bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
	return data instanceof Uint8Array ? data : await stream_to_bytes(data);
}

/**
 * Create an event emitter function from an optional handler.
 */
export function create_emitter(handler?: EventHandler): (event: CorpusEvent) => void {
	return (event: CorpusEvent) => handler?.(event);
}

/**
 * Configuration for a filter pipeline.
 * @typeParam T - The type of items being filtered
 * @typeParam Opts - The options type containing filter criteria
 */
export type FilterPipelineConfig<T, Opts> = {
	filters: Array<{
		key: keyof Opts;
		predicate: (item: T, opt_value: NonNullable<Opts[keyof Opts]>) => boolean;
	}>;
	sort: (a: T, b: T) => number;
};

/**
 * Creates a reusable filter pipeline function.
 * Applies filters based on options, sorts results, and applies optional limit.
 *
 * @typeParam T - The type of items being filtered
 * @typeParam Opts - The options type (must include optional limit)
 * @param config - Filter definitions and sort function
 * @returns A function that filters, sorts, and limits items
 *
 * @example
 * ```ts
 * const filter_users = create_filter_pipeline<User, UserQueryOpts>({
 *   filters: [
 *     { key: 'role', predicate: (u, role) => u.role === role },
 *     { key: 'active', predicate: (u, active) => u.active === active }
 *   ],
 *   sort: (a, b) => b.created_at.getTime() - a.created_at.getTime()
 * })
 *
 * const results = filter_users(users, { role: 'admin', limit: 10 })
 * ```
 */
export function create_filter_pipeline<T, Opts extends { limit?: number }>(
	config: FilterPipelineConfig<T, Opts>,
): (items: T[], opts: Opts) => T[] {
	return (items, opts) => {
		let filtered = items;
		for (const { key, predicate } of config.filters) {
			const opt_value = opts[key];
			if (opt_value !== undefined && opt_value !== null) {
				filtered = filtered.filter((item) => predicate(item, opt_value as NonNullable<Opts[keyof Opts]>));
			}
		}
		filtered.sort(config.sort);
		if (opts.limit) {
			filtered = filtered.slice(0, opts.limit);
		}
		return filtered;
	};
}

const snapshot_filter_pipeline = create_filter_pipeline<SnapshotMeta, ListOpts>({
	filters: [
		{ key: "before", predicate: (m, before) => m.created_at < (before as Date) },
		{ key: "after", predicate: (m, after) => m.created_at > (after as Date) },
		{
			key: "tags",
			predicate: (m, tags) => (tags as string[]).every((tag) => m.tags?.includes(tag)),
		},
	],
	sort: (a, b) => b.created_at.getTime() - a.created_at.getTime(),
});

/**
 * Filter and sort snapshot metadata based on list options.
 * Used by in-memory storage implementations (memory backend, file backend).
 */
export function filter_snapshots(metas: SnapshotMeta[], opts: ListOpts = {}): SnapshotMeta[] {
	return snapshot_filter_pipeline(metas, opts);
}

/**
 * Parse a raw snapshot object (from JSON or database row) into a proper SnapshotMeta.
 * Handles date string conversion and JSON parsing of array fields.
 */
export function parse_snapshot_meta(raw: {
	store_id: string;
	version: string;
	data_key: string;
	created_at: string | Date;
	invoked_at?: string | Date | null;
	parents?: string | ParentRef[] | null;
	tags?: string | string[] | null;
	content_hash?: string;
	content_type?: string;
	size_bytes?: number;
}): SnapshotMeta {
	return {
		store_id: raw.store_id,
		version: raw.version,
		data_key: raw.data_key,
		created_at: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
		invoked_at: raw.invoked_at
			? raw.invoked_at instanceof Date
				? raw.invoked_at
				: new Date(raw.invoked_at)
			: undefined,
		parents: raw.parents
			? typeof raw.parents === "string"
				? (JSON.parse(raw.parents) as ParentRef[])
				: raw.parents
			: [],
		tags: raw.tags ? (typeof raw.tags === "string" ? (JSON.parse(raw.tags) as string[]) : raw.tags) : undefined,
		content_hash: raw.content_hash ?? "",
		content_type: raw.content_type ?? "application/octet-stream",
		size_bytes: raw.size_bytes ?? 0,
	};
}
