/**
 * @module Backends
 * @description R2 S3-compatible object storage using Bun's native S3Client.
 */

import { try_catch_async } from "../result.js";
import type { DataStorage, DataStorageHandle } from "./base.js";

/**
 * Configuration for R2 S3 data storage.
 * @category Backends
 * @group Storage Configuration
 *
 * Credentials derive from an R2 API token:
 * - `access_key_id`: The token ID
 * - `secret_access_key`: SHA-256 hash of the token value
 *
 * @example
 * ```ts
 * const config: R2S3Config = {
 *   account_id: "abc123def456",
 *   bucket: "my-corpus-bucket",
 *   access_key_id: "token_id_here",
 *   secret_access_key: "token_secret_hash_here",
 * }
 * ```
 */
export type R2S3Config = {
	/** Cloudflare account ID. */
	account_id: string;
	/** R2 bucket name. */
	bucket: string;
	/** R2 API token access key ID. */
	access_key_id: string;
	/** R2 API token secret access key (SHA-256 hash). */
	secret_access_key: string;
	/** Optional endpoint override (e.g., for testing). Defaults to Cloudflare R2 endpoint. */
	endpoint?: string;
};

/**
 * Structural type for the S3 file handle.
 * Represents exactly the methods we use from Bun.S3Client's file handles.
 */
type S3FileLike = {
	exists: () => Promise<boolean>;
	arrayBuffer: () => Promise<ArrayBufferLike>;
	stream: () => ReadableStream<Uint8Array>;
	write: (data: Uint8Array) => Promise<unknown>;
	delete: () => Promise<void>;
	size: number;
};

/**
 * Structural type for the S3 client.
 * Represents exactly the methods we use from Bun.S3Client.
 */
type S3ClientLike = {
	file: (key: string) => S3FileLike;
};

/**
 * Creates an R2 data storage adapter using Bun's native S3Client.
 * @category Backends
 * @group Storage Backends
 *
 * Implements the DataStorage interface for R2 object storage, using Bun's native
 * S3Client for efficient I/O. Returns null for missing objects rather than throwing,
 * and preserves native streaming for efficient reads.
 *
 * @param config - Configuration with bucket, credentials, and optional endpoint
 * @returns A DataStorage instance for R2 operations
 *
 * @example
 * ```ts
 * const storage = create_r2_data_storage({
 *   account_id: "abc123",
 *   bucket: "my-bucket",
 *   access_key_id: "token_id",
 *   secret_access_key: "token_hash",
 * })
 *
 * // Returns DataStorageHandle with lazy bytes() and native stream()
 * const handle = await storage.get("store/v1")
 * if (handle) {
 *   const bytes = await handle.bytes()
 * }
 * ```
 */
export function create_r2_data_storage(config: R2S3Config): DataStorage {
	const endpoint = config.endpoint ?? `https://${config.account_id}.r2.cloudflarestorage.com`;

	// Construct client using Bun.S3Client. Public surface uses structural typing
	// to avoid leaking the Bun global into emitted .d.ts.
	const s3_client: S3ClientLike = new Bun.S3Client({
		accessKeyId: config.access_key_id,
		secretAccessKey: config.secret_access_key,
		bucket: config.bucket,
		endpoint,
	});

	return {
		async get(data_key) {
			const file = s3_client.file(data_key);

			// Probe for existence. S3Client.file().exists() returns false for 404.
			const exists_result = await try_catch_async(
				() => file.exists(),
				() => false,
			);

			if (!exists_result.ok || !exists_result.value) {
				return null;
			}

			// Object exists. Return handle with lazy bytes() and native stream().
			const handle: DataStorageHandle = {
				bytes: async () => {
					const buffer = await file.arrayBuffer();
					return new Uint8Array(buffer);
				},
				stream: () => file.stream(),
				size: file.size,
			};

			return handle;
		},

		async put(data_key, data) {
			const file = s3_client.file(data_key);
			await file.write(data);
		},

		async delete(data_key) {
			const file = s3_client.file(data_key);
			// Ignore 404s on delete (idempotent) — result intentionally unchecked.
			const result = await try_catch_async(
				() => file.delete(),
				() => undefined,
			);
			void result;
		},

		async exists(data_key) {
			const file = s3_client.file(data_key);
			const result = await try_catch_async(
				() => file.exists(),
				() => false,
			);
			return result.ok ? result.value : false;
		},
	};
}
