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
