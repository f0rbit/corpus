/**
 * @module Backends
 * @description In-memory storage backend for testing and development.
 */

import type { Backend, MetadataClient, DataClient, SnapshotMeta, Result, CorpusError } from "../types";
import type { ObservationRow } from "../observations";
import { create_observations_client, create_observations_storage } from "../observations";
import { ok, err } from "../types";
import { to_bytes, create_emitter, filter_snapshots } from "../utils";
import type { EventHandler } from "../types";

export type MemoryBackendOptions = {
	on_event?: EventHandler;
};

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

	const metadata: MetadataClient = {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			const meta = meta_store.get(make_meta_key(store_id, version));
			emit({ type: "meta_get", store_id, version, found: !!meta });
			if (!meta) {
				return err({ kind: "not_found", store_id, version });
			}
			return ok(meta);
		},

		async put(meta): Promise<Result<void, CorpusError>> {
			meta_store.set(make_meta_key(meta.store_id, meta.version), meta);
			emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
			return ok(undefined);
		},

		async delete(store_id, version): Promise<Result<void, CorpusError>> {
			meta_store.delete(make_meta_key(store_id, version));
			emit({ type: "meta_delete", store_id, version });
			return ok(undefined);
		},

		async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
			const prefix = `${store_id}:`;
			const store_metas: SnapshotMeta[] = [];

			for (const [key, meta] of meta_store) {
				if (key.startsWith(prefix)) {
					store_metas.push(meta);
				}
			}

			const filtered = filter_snapshots(store_metas, opts);
			let count = 0;
			for (const meta of filtered) {
				yield meta;
				count++;
			}
			emit({ type: "meta_list", store_id, count });
		},

		async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
			let latest: SnapshotMeta | null = null;
			const prefix = `${store_id}:`;

			for (const [key, meta] of meta_store) {
				if (!key.startsWith(prefix)) continue;
				if (!latest || meta.created_at > latest.created_at) {
					latest = meta;
				}
			}

			if (!latest) {
				return err({ kind: "not_found", store_id, version: "latest" });
			}
			return ok(latest);
		},

		async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
			for (const meta of meta_store.values()) {
				const is_child = meta.parents.some(p => p.store_id === parent_store_id && p.version === parent_version);
				if (is_child) yield meta;
			}
		},

		async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
			const prefix = `${store_id}:`;
			for (const [key, meta] of meta_store) {
				if (key.startsWith(prefix) && meta.content_hash === content_hash) {
					return meta;
				}
			}
			return null;
		},
	};

	const data: DataClient = {
		async get(data_key): Promise<Result<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> }, CorpusError>> {
			const bytes = data_store.get(data_key);
			emit({ type: "data_get", store_id: data_key.split("/")[0] ?? data_key, version: data_key, found: !!bytes });
			if (!bytes) {
				return err({ kind: "not_found", store_id: data_key, version: "" });
			}

			return ok({
				stream: () =>
					new ReadableStream({
						start(controller) {
							controller.enqueue(bytes);
							controller.close();
						},
					}),
				bytes: async () => bytes,
			});
		},

		async put(data_key, input): Promise<Result<void, CorpusError>> {
			const bytes = await to_bytes(input)
			data_store.set(data_key, bytes);
			return ok(undefined);
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			data_store.delete(data_key);
			return ok(undefined);
		},

		async exists(data_key): Promise<boolean> {
			return data_store.has(data_key);
		},
	};

	const storage = create_observations_storage({
		get_all: async () => Array.from(observation_store.values()),
		set_all: async (rows) => {
			observation_store.clear()
			for (const row of rows) observation_store.set(row.id, row)
		},
		get_one: async (id) => observation_store.get(id) ?? null,
		add_one: async (row) => { observation_store.set(row.id, row) },
		remove_one: async (id) => {
			const had = observation_store.has(id)
			observation_store.delete(id)
			return had
		}
	})
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event };
}
