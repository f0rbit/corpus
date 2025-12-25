/**
 * @module Backends
 * @description In-memory storage backend for testing and development.
 */

import type { Backend, SnapshotMeta } from "../types";
import type { ObservationRow } from "../observations";
import { create_observations_client, create_observations_storage } from "../observations";
import { create_emitter } from "../utils";
import type { EventHandler } from "../types";
import { create_metadata_client, create_data_client } from "./base";
import type { MetadataStorage, DataStorage } from "./base";

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

	const metadata_storage: MetadataStorage = {
		async get(store_id, version) {
			return meta_store.get(make_meta_key(store_id, version)) ?? null;
		},

		async put(meta) {
			meta_store.set(make_meta_key(meta.store_id, meta.version), meta);
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
			return data_store.get(data_key) ?? null;
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

	const storage = create_observations_storage({
		get_all: async () => Array.from(observation_store.values()),
		set_all: async (rows) => {
			observation_store.clear();
			for (const row of rows) observation_store.set(row.id, row);
		},
		get_one: async (id) => observation_store.get(id) ?? null,
		add_one: async (row) => {
			observation_store.set(row.id, row);
		},
		remove_one: async (id) => {
			const had = observation_store.has(id);
			observation_store.delete(id);
			return had;
		},
	});
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event };
}
