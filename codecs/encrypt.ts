/**
 * @module Codecs / Encrypt
 * @description AES-GCM byte-transformer codec via WebCrypto.
 */

import type { BytesCodec } from '../types.js'

const IV_LENGTH = 12

async function encrypt_bytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes as Uint8Array<ArrayBuffer>)
	const out = new Uint8Array(iv.length + ciphertext.byteLength)
	out.set(iv, 0)
	out.set(new Uint8Array(ciphertext), iv.length)
	return out
}

async function decrypt_bytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
	const iv = bytes.slice(0, IV_LENGTH)
	const ciphertext = bytes.slice(IV_LENGTH)
	const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext as Uint8Array<ArrayBuffer>)
	return new Uint8Array(plaintext)
}

/**
 * Creates an AES-GCM byte-transformer codec.
 *
 * Encrypts on encode, decrypts on decode. A fresh 12-byte IV is generated per
 * encode call and prepended to the ciphertext for self-contained decoding —
 * no caller-side IV management is required.
 *
 * Streaming notes:
 * - `encode_stream` is present (one-chunk wrapper around `encode`). True
 *   chunked encryption is not implemented — AES-GCM authenticates the whole
 *   ciphertext via a tag at the end, and the standard WebCrypto API exposes
 *   only the one-shot form.
 * - `decode_stream` is **intentionally omitted**. AES-GCM must verify the
 *   auth tag before any plaintext is safe to release; yielding chunks early
 *   would leak unauthenticated data. Including `encrypt_codec()` in a
 *   `compose(...)` chain therefore disables streaming decode for the whole
 *   pipeline (by structural inference — see `compose()` docs).
 *
 * Security caveats:
 * - Random IV per encode means the same plaintext encrypts to different
 *   ciphertexts each time. As a result, content-hash deduplication (a
 *   `compose(json_codec(S), encrypt_codec(key))` pipeline) cannot dedup
 *   identical plaintexts. This is the correct security tradeoff — opt-in
 *   deterministic encryption is a footgun.
 *
 * @category Codecs
 * @group Codec Factories
 * @param key - An AES-GCM `CryptoKey` (use `crypto.subtle.generateKey` or
 *   import from raw bytes via `crypto.subtle.importKey`)
 * @returns A `BytesCodec` that encrypts on encode and decrypts on decode
 *
 * @example
 * ```ts
 * import { compose, json_codec, gzip_codec, encrypt_codec } from '@f0rbit/corpus'
 *
 * const key = await crypto.subtle.generateKey(
 *   { name: 'AES-GCM', length: 256 },
 *   true,
 *   ['encrypt', 'decrypt']
 * )
 *
 * const codec = compose(json_codec(SecretSchema), gzip_codec(), encrypt_codec(key))
 * ```
 */
export function encrypt_codec(key: CryptoKey): BytesCodec {
	return {
		content_type: 'application/octet-stream',
		encode: (bytes) => encrypt_bytes(key, bytes),
		decode: (bytes) => decrypt_bytes(key, bytes),
		encode_stream(value) {
			return new ReadableStream<Uint8Array>({
				async start(controller) {
					try {
						controller.enqueue(await encrypt_bytes(key, value))
						controller.close()
					} catch (cause) {
						controller.error(cause)
					}
				},
			})
		},
		// decode_stream INTENTIONALLY OMITTED — see module docstring.
	}
}
