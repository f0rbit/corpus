/**
 * @module Utilities
 * @description Utility functions for hashing, versioning, and codecs.
 */

import type { Codec, CorpusEvent, EventHandler, SnapshotMeta, ListOpts, ParentRef, ContentType } from "./types";

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
  const hash_buffer = await crypto.subtle.digest('SHA-256', data)
  const hash_array = new Uint8Array(hash_buffer)
  return Array.from(hash_array).map(b => b.toString(16).padStart(2, '0')).join('')
}

let last_timestamp = 0
let sequence = 0

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
  const now = Date.now()
  
  if (now === last_timestamp) {
    sequence++
  } else {
    last_timestamp = now
    sequence = 0
  }
  
  // base64url encode the timestamp (no padding, url-safe)
  const timestamp_bytes = new Uint8Array(8)
  const view = new DataView(timestamp_bytes.buffer)
  view.setBigUint64(0, BigInt(now), false) // big-endian for lexicographic sorting
  
  // trim leading zeros for compactness
  let start = 0
  while (start < 7 && timestamp_bytes[start] === 0) start++
  const trimmed = timestamp_bytes.slice(start)
  
  const base64 = btoa(String.fromCharCode(...trimmed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  
  return sequence > 0 ? `${base64}.${sequence}` : base64
}

// Use a structural type that matches both Zod 3.x and 4.x
type ZodLike<T> = { parse: (data: unknown) => T };

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
export function json_codec<T>(schema: ZodLike<T>): Codec<T> {
	return {
		content_type: "application/json",
		encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
		decode: (bytes) => schema.parse(JSON.parse(new TextDecoder().decode(bytes))),
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
		encode: (value) => new TextEncoder().encode(value),
		decode: (bytes) => new TextDecoder().decode(bytes),
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
		encode: (value) => value,
		decode: (bytes) => bytes,
	};
}

/**
 * Concatenate multiple Uint8Array chunks into a single array.
 */
export function concat_bytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0)
	const result = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}

/**
 * Read a stream into a single Uint8Array.
 */
export async function stream_to_bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = []
	const reader = stream.getReader()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
	}
	return concat_bytes(chunks)
}

/**
 * Convert a stream or Uint8Array to Uint8Array.
 */
export async function to_bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
	return data instanceof Uint8Array ? data : await stream_to_bytes(data)
}

/**
 * Create an event emitter function from an optional handler.
 */
export function create_emitter(handler?: EventHandler): (event: CorpusEvent) => void {
	return (event: CorpusEvent) => handler?.(event)
}

/**
 * Filter and sort snapshot metadata based on list options.
 * Used by in-memory storage implementations (memory backend, file backend).
 */
export function filter_snapshots(
	metas: SnapshotMeta[],
	opts: ListOpts = {}
): SnapshotMeta[] {
	let filtered = metas

	if (opts.before) {
		filtered = filtered.filter(m => m.created_at < opts.before!)
	}
	if (opts.after) {
		filtered = filtered.filter(m => m.created_at > opts.after!)
	}

	if (opts.tags && opts.tags.length > 0) {
		filtered = filtered.filter(m =>
			opts.tags!.every(tag => m.tags?.includes(tag))
		)
	}

	filtered.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())

	if (opts.limit) {
		filtered = filtered.slice(0, opts.limit)
	}

	return filtered
}

/**
 * Parse a raw snapshot object (from JSON or database row) into a proper SnapshotMeta.
 * Handles date string conversion and JSON parsing of array fields.
 */
export function parse_snapshot_meta(raw: {
  store_id: string
  version: string
  data_key: string
  created_at: string | Date
  invoked_at?: string | Date | null
  parents?: string | ParentRef[] | null
  tags?: string | string[] | null
  content_hash?: string
  content_type?: string
  size_bytes?: number
}): SnapshotMeta {
  return {
    store_id: raw.store_id,
    version: raw.version,
    data_key: raw.data_key,
    created_at: raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
    invoked_at: raw.invoked_at 
      ? (raw.invoked_at instanceof Date ? raw.invoked_at : new Date(raw.invoked_at))
      : undefined,
    parents: raw.parents
      ? (typeof raw.parents === 'string' ? JSON.parse(raw.parents) : raw.parents)
      : [],
    tags: raw.tags
      ? (typeof raw.tags === 'string' ? JSON.parse(raw.tags) : raw.tags)
      : undefined,
    content_hash: raw.content_hash ?? '',
    content_type: (raw.content_type ?? 'application/octet-stream') as ContentType,
    size_bytes: raw.size_bytes ?? 0,
  }
}
