/**
 * @module testing/register
 * @description Corpus's own testing registrar.
 *
 * Exports branded symbols for corpus types (CorpusError, SnapshotMeta, BatchOp)
 * and registers initial arbitraries for them. Downstream packages import these
 * symbols and call `testing.failure(CORPUS_ERROR_BRAND, "variant", ...)` to
 * register per-variant generators — or simply rely on the corpus-shipped ones
 * registered by {@link register} below.
 *
 * Called explicitly by Phase 4's vending walker — this file does NOT auto-execute
 * on import. Phase 1 shipped the stub with SnapshotMeta registration only;
 * Phase 2 lights up the CORPUS_ERROR_BRAND failure registrations (12 variants).
 */

import fc from 'fast-check';
import type { ArbBrand } from './types.js';
import { arbitrary } from './registry.js';
import { compose } from './compose.js';
import { failure } from './failure.js';

import type { CorpusError, SnapshotMeta, BatchOp } from '../types.js';

/**
 * Branded symbol for CorpusError. Used to register per-variant failure generators
 * via `testing.failure(CORPUS_ERROR_BRAND, "not_found", ...)`.
 */
export const CORPUS_ERROR_BRAND = Symbol('CorpusError') as ArbBrand<CorpusError>;

/**
 * Branded symbol for SnapshotMeta. Used to register/lookup the canonical
 * SnapshotMeta arbitrary via `testing.arbitrary(SNAPSHOT_META_BRAND, ...)`.
 */
export const SNAPSHOT_META_BRAND = Symbol('SnapshotMeta') as ArbBrand<SnapshotMeta>;

/**
 * Branded symbol for BatchOp. Used to register/lookup the canonical BatchOp
 * arbitrary via `testing.arbitrary(BATCH_OP_BRAND, ...)`.
 */
export const BATCH_OP_BRAND = Symbol('BatchOp') as ArbBrand<BatchOp>;

const non_empty_string = fc.string({ minLength: 1, maxLength: 50 });
const hex_hash = fc.stringMatching(/^[a-f0-9]{64}$/);
const error_arb: fc.Arbitrary<Error> = fc.string({ minLength: 1, maxLength: 80 }).map((m) => new Error(m));

/**
 * Register corpus's own arbitraries. Called explicitly during test setup or by
 * the vending walker (Phase 4). Idempotent — calling twice produces warnings
 * but does not corrupt the registry.
 */
export function register(): void {
	register_snapshot_meta();
	register_corpus_error_variants();
}

function register_snapshot_meta(): void {
	const snapshot_meta_arb = compose((draw) => {
		const store_id = draw(non_empty_string);
		const version = draw(non_empty_string);
		const content_hash = draw(hex_hash);
		const created_at = draw(fc.date());
		const size_bytes = draw(fc.integer({ min: 0, max: 1000000000 }));
		const data_key = draw(fc.string({ minLength: 1, maxLength: 100 }));
		const tags = draw(fc.option(fc.array(fc.string(), { maxLength: 5 })));

		return {
			store_id,
			version,
			parents: [],
			created_at,
			content_hash,
			content_type: 'application/octet-stream' as const,
			size_bytes,
			data_key,
			tags: tags ?? undefined,
		};
	});

	arbitrary(SNAPSHOT_META_BRAND, snapshot_meta_arb);
}

function register_corpus_error_variants(): void {
	failure(
		CORPUS_ERROR_BRAND,
		'not_found',
		compose((draw) => ({
			kind: 'not_found' as const,
			store_id: draw(non_empty_string),
			version: draw(non_empty_string),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'already_exists',
		compose((draw) => ({
			kind: 'already_exists' as const,
			store_id: draw(non_empty_string),
			version: draw(non_empty_string),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'storage_error',
		compose((draw) => ({
			kind: 'storage_error' as const,
			cause: draw(error_arb),
			operation: draw(fc.constantFrom('meta_get', 'meta_put', 'meta_delete', 'data_get', 'data_put', 'data_delete')),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'decode_error',
		compose((draw) => ({
			kind: 'decode_error' as const,
			cause: draw(error_arb),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'encode_error',
		compose((draw) => ({
			kind: 'encode_error' as const,
			cause: draw(error_arb),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'hash_mismatch',
		compose((draw) => ({
			kind: 'hash_mismatch' as const,
			expected: draw(hex_hash),
			actual: draw(hex_hash),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'invalid_config',
		compose((draw) => ({
			kind: 'invalid_config' as const,
			message: draw(fc.string({ minLength: 1, maxLength: 200 })),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'validation_error',
		compose((draw) => ({
			kind: 'validation_error' as const,
			cause: draw(error_arb),
			message: draw(fc.string({ minLength: 1, maxLength: 200 })),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'observation_not_found',
		compose((draw) => ({
			kind: 'observation_not_found' as const,
			id: draw(non_empty_string),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'transaction_aborted',
		compose((draw) => {
			const reason = draw(fc.constantFrom('returned_err', 'threw', 'apply_batch_failed') as fc.Arbitrary<'returned_err' | 'threw' | 'apply_batch_failed'>);
			const has_cause = draw(fc.boolean());
			const base = { kind: 'transaction_aborted' as const, reason };
			return has_cause ? { ...base, cause: draw(error_arb) } : base;
		}),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'partial_commit',
		compose((draw) => ({
			kind: 'partial_commit' as const,
			ops_completed: draw(fc.integer({ min: 0, max: 100 })),
			ops_failed: draw(fc.integer({ min: 1, max: 100 })),
			cause: draw(error_arb),
		})),
	);

	failure(
		CORPUS_ERROR_BRAND,
		'concurrent_modification',
		compose((draw) => ({
			kind: 'concurrent_modification' as const,
			store_id: draw(non_empty_string),
			version: draw(non_empty_string),
		})),
	);
}
