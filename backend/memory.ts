/**
 * @module Backends
 * @description In-memory storage backend for testing and development.
 */

import type { Backend, BatchOp, CorpusError, Result, SnapshotMeta } from '../types.js';
import type { ObservationRow } from '../observations/index.js';
import { create_observations_client, create_observations_storage } from '../observations/index.js';
import { create_emitter } from '../utils.js';
import { ok, err } from '../types.js';
import type { EventHandler } from '../types.js';
import { create_metadata_client, create_data_client } from './base.js';
import type { MetadataStorage, DataStorage } from './base.js';

export type MemoryBackendOptions = {
	on_event?: EventHandler;
};

/**
 * When true, freeze SnapshotMeta and ObservationRow objects on insert into
 * the in-memory maps. Catches consumer mutation bugs that would corrupt the
 * shallow snapshot used for transaction rollback (see `apply_batch`).
 *
 * Opt-in via `process.env.CORPUS_DEV === '1'`. Hot-path expensive in
 * production — leave off unless you suspect mutation bugs in your consumer.
 * The check is read once at module load (not per-op) so toggling it after
 * the fact is a no-op.
 */
const CORPUS_DEV: boolean = (() => {
	try {
		return typeof process !== 'undefined' && process.env?.CORPUS_DEV === '1';
	} catch {
		return false;
	}
})();

/**
 * Creates an in-memory storage backend.
 * @category Backends
 * @group Storage Backends
 *
 * Ideal for testing, development, and ephemeral storage scenarios.
 * All data is lost when the process ends.
 *
 * @param options - Optional configuration with `on_event` handler for observability
 * @returns A Backend instance using in-memory storage
 *
 * @example
 * ```ts
 * // Basic usage for testing
 * const backend = create_memory_backend()
 * const corpus = create_corpus()
 *   .with_backend(backend)
 *   .with_store(define_store('test', text_codec()))
 *   .build()
 *
 * // With event logging
 * const backend = create_memory_backend({
 *   on_event: (e) => console.log(`[${e.type}]`, e)
 * })
 * ```
 */
export function create_memory_backend(options?: MemoryBackendOptions): Backend {
	const meta_store = new Map<string, SnapshotMeta>();
	const data_store = new Map<string, Uint8Array>();
	const observation_store = new Map<string, ObservationRow>();
	const on_event = options?.on_event;
	const emit = create_emitter(on_event);

	function make_meta_key(store_id: string, version: string): string {
		return `${store_id}:${version}`;
	}

	const metadata_storage: MetadataStorage = {
		async get(store_id, version) {
			return meta_store.get(make_meta_key(store_id, version)) ?? null;
		},

		async put(meta) {
			meta_store.set(make_meta_key(meta.store_id, meta.version), CORPUS_DEV ? Object.freeze({ ...meta }) : meta);
		},

		async delete(store_id, version) {
			meta_store.delete(make_meta_key(store_id, version));
		},

		async *list(store_id) {
			const prefix = store_id ? `${store_id}:` : "";
			for (const [key, meta] of meta_store) {
				if (!prefix || key.startsWith(prefix)) {
					yield meta;
				}
			}
		},

		async find_by_hash(store_id, content_hash) {
			const prefix = `${store_id}:`;
			for (const [key, meta] of meta_store) {
				if (key.startsWith(prefix) && meta.content_hash === content_hash) {
					return meta;
				}
			}
			return null;
		},
	};

	const data_storage: DataStorage = {
		async get(data_key) {
			const bytes = data_store.get(data_key);
			if (!bytes) return null;
			return {
				bytes: async () => bytes,
				stream: () => new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				size: bytes.byteLength,
			};
		},

		async put(data_key, data) {
			data_store.set(data_key, data);
		},

		async delete(data_key) {
			data_store.delete(data_key);
		},

		async exists(data_key) {
			return data_store.has(data_key);
		},
	};

	const metadata = create_metadata_client(metadata_storage, emit);
	const data = create_data_client(data_storage, emit);

	/**
	 * Atomically apply a batch of ops. Snapshots all three in-memory maps
	 * before the loop and restores them if any op throws. The maps are
	 * mutated synchronously so no `await` interleaves between snapshot and
	 * restore — the rollback is genuinely atomic from any other call's
	 * perspective.
	 *
	 * Snapshots are shallow on values: we treat SnapshotMeta and ObservationRow
	 * as immutable inside corpus. Set CORPUS_DEV=1 to enforce this with
	 * Object.freeze (catches consumer-side mutation bugs).
	 */
	async function apply_batch(ops: BatchOp[]): Promise<Result<void, CorpusError>> {
		const meta_snap = new Map(meta_store);
		const data_snap = new Map(data_store);
		const obs_snap = new Map(observation_store);
		try {
			for (const op of ops) {
				switch (op.type) {
					case 'meta_put':
						meta_store.set(
							make_meta_key(op.meta.store_id, op.meta.version),
							CORPUS_DEV ? Object.freeze({ ...op.meta }) : op.meta,
						);
						break;
					case 'meta_delete':
						meta_store.delete(make_meta_key(op.store_id, op.version));
						break;
					case 'data_put':
						data_store.set(op.data_key, op.bytes);
						break;
					case 'observation_put':
						observation_store.set(op.row.id, CORPUS_DEV ? Object.freeze({ ...op.row }) : op.row);
						break;
					case 'observation_delete':
						observation_store.delete(op.id);
						break;
				}
			}
			return ok(undefined);
		} catch (cause) {
			meta_store.clear();
			for (const [k, v] of meta_snap) meta_store.set(k, v);
			data_store.clear();
			for (const [k, v] of data_snap) data_store.set(k, v);
			observation_store.clear();
			for (const [k, v] of obs_snap) observation_store.set(k, v);
			return err({
				kind: 'transaction_aborted',
				reason: 'apply_batch_failed',
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			});
		}
	}

	const storage = create_observations_storage({
		get_all: async () => Array.from(observation_store.values()),
		set_all: async (rows) => {
			observation_store.clear();
			for (const row of rows) observation_store.set(row.id, row);
		},
		get_one: async (id) => observation_store.get(id) ?? null,
		add_one: async (row) => {
			observation_store.set(row.id, CORPUS_DEV ? Object.freeze({ ...row }) : row);
		},
		remove_one: async (id) => {
			const had = observation_store.has(id);
			observation_store.delete(id);
			return had;
		},
	});
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event, apply_batch };
}
