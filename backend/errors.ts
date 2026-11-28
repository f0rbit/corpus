/**
 * @module backend/errors
 * @description Shared error constructors for backend storage layers (no drizzle import — Workers-safe).
 */

import type { CorpusError } from "../types.js";

export function to_error(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

// A data client sees only the key, not the snapshot: store_id is the key's
// first segment (exact under the default `${store_id}/${content_hash}` layout),
// version carries the full key so the rendered message still locates the blob.
export function data_not_found(data_key: string): CorpusError {
	return {
		kind: "not_found",
		store_id: data_key.split("/")[0] || data_key,
		version: data_key,
		message: "data object missing",
	};
}

export function storage_error(operation: string): (cause: unknown) => CorpusError {
	return (cause) => ({ kind: "storage_error", cause: to_error(cause), operation });
}
