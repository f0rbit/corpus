import type { Codec } from "./types";

// ============================================================================
// Hash
// ============================================================================

export async function compute_hash(data: Uint8Array): Promise<string> {
  const hash_buffer = await crypto.subtle.digest('SHA-256', data)
  const hash_array = new Uint8Array(hash_buffer)
  return Array.from(hash_array).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ============================================================================
// Version
// ============================================================================

let last_timestamp = 0
let sequence = 0

/**
 * Generates a unique, sortable version string.
 * Format: base64url-encoded timestamp with optional sequence suffix for same-millisecond calls.
 * Versions sort lexicographically in chronological order.
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

// ============================================================================
// Codecs
// ============================================================================

// Use a structural type that matches both Zod 3.x and 4.x
type ZodLike<T> = { parse: (data: unknown) => T };

export function json_codec<T>(schema: ZodLike<T>): Codec<T> {
	return {
		content_type: "application/json",
		encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
		decode: (bytes) => schema.parse(JSON.parse(new TextDecoder().decode(bytes))),
	};
}

export function text_codec(): Codec<string> {
	return {
		content_type: "text/plain",
		encode: (value) => new TextEncoder().encode(value),
		decode: (bytes) => new TextDecoder().decode(bytes),
	};
}

export function binary_codec(): Codec<Uint8Array> {
	return {
		content_type: "application/octet-stream",
		encode: (value) => value,
		decode: (bytes) => bytes,
	};
}
