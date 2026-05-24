/**
 * @module testing/register
 * @description Corpus's own testing registrar.
 *
 * Exports branded symbols for corpus types (CorpusError, SnapshotMeta, BatchOp)
 * and registers initial arbitraries for them. Downstream packages import these
 * symbols and call `testing.failure(CORPUS_ERROR_BRAND, "variant", ...)` to
 * register per-variant generators.
 *
 * Called explicitly by Phase 4's vending walker — this file does NOT auto-execute
 * on import. Phase 1 ships the stub with SnapshotMeta registration only; Phase 2
 * adds CorpusError failure registrations.
 */

import fc from 'fast-check';
import type { ArbBrand } from './types.js';
import { arbitrary } from './registry.js';
import { compose } from './compose.js';
import { arb } from './arb.js';
import { z } from 'zod';

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

/**
 * Register corpus's own arbitraries. Called explicitly during test setup or by
 * the vending walker (Phase 4). Idempotent — calling twice produces warnings
 * but does not corrupt the registry.
 */
export function register(): void {
	// Register SnapshotMeta arbitrary.
	// Produces well-formed metadata with non-empty store_id, valid version string,
	// 64-char hex content_hash, etc.
	const snapshot_meta_arb = compose((draw) => {
		const store_id = draw(fc.string({ minLength: 1, maxLength: 50 }));
		const version = draw(fc.string({ minLength: 1, maxLength: 50 }));
		const content_hash = draw(
			fc.stringMatching(/^[a-f0-9]{64}$/)
		);
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
