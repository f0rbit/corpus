/**
 * @module backend/errors
 * @description Shared error constructors for backend storage layers (no drizzle import — Workers-safe).
 */

import type { CorpusError } from "../types.js";

export function to_error(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

export function storage_error(operation: string): (cause: unknown) => CorpusError {
	return (cause) => ({ kind: "storage_error", cause: to_error(cause), operation });
}
