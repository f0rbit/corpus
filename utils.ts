import type { Codec } from "./types";

/**
 * Computes the SHA-256 hash of binary data.
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
