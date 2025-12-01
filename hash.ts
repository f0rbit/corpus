export async function compute_hash(data: Uint8Array): Promise<string> {
  const hash_buffer = await crypto.subtle.digest('SHA-256', data)
  const hash_array = new Uint8Array(hash_buffer)
  return Array.from(hash_array).map(b => b.toString(16).padStart(2, '0')).join('')
}
