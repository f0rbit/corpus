/**
 * @module Backends
 * @description File-system storage backend for local persistence.
 */

import type { Backend, SnapshotMeta, EventHandler } from '../types.js';
import type { ObservationRow } from '../observations/index.js';
import { create_observations_client, create_observations_storage } from '../observations/index.js';
import { create_emitter, parse_snapshot_meta } from '../utils.js';
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { create_metadata_client, create_data_client } from './base.js';
import type { MetadataStorage, DataStorage } from './base.js';

export type FileBackendConfig = {
	base_path: string;
	on_event?: EventHandler;
};

/**
 * Creates a file-system storage backend for local persistence.
 * @category Backends
 * @group Storage Backends
 *
 * Uses Bun's file APIs for efficient I/O. Metadata is stored as JSON files
 * per store, and data is stored as binary files in a shared `_data` directory.
 *
 * Directory structure:
 * ```
 * base_path/
 *   <store_id>/_meta.json     # Metadata for each store
 *   _data/<store_id>_<hash>.bin  # Binary data files
 * ```
 *
 * @param config - Configuration with `base_path` (root directory) and optional `on_event` handler
 * @returns A Backend instance using file-system storage
 *
 * @example
 * ```ts
 * const backend = create_file_backend({
 *   base_path: './data/corpus',
 *   on_event: (e) => console.log(e.type)
 * })
 *
 * const corpus = create_corpus()
 *   .with_backend(backend)
 *   .with_store(define_store('documents', json_codec(DocSchema)))
 *   .build()
 * ```
 */
export function create_file_backend(config: FileBackendConfig): Backend {
	const { base_path, on_event } = config;
	const emit = create_emitter(on_event);

	function meta_path(store_id: string): string {
		return join(base_path, store_id, "_meta.json");
	}

	function data_path(data_key: string): string {
		return join(base_path, "_data", `${data_key.replace(/\//g, "_")}.bin`);
	}

	async function read_store_meta(store_id: string): Promise<Map<string, SnapshotMeta>> {
		const path = meta_path(store_id);
		const file = Bun.file(path);
		if (!(await file.exists())) return new Map();

		try {
			const content = await file.text();
			const entries = JSON.parse(content) as [string, unknown][];
			return new Map(entries.map(([key, raw]) => [key, parse_snapshot_meta(raw as any)]));
		} catch {
			return new Map();
		}
	}

	async function write_store_meta(store_id: string, meta_map: Map<string, SnapshotMeta>): Promise<void> {
		const path = meta_path(store_id);
		await mkdir(dirname(path), { recursive: true });
		const entries = Array.from(meta_map.entries());
		await Bun.write(path, JSON.stringify(entries));
	}

	async function* list_all_stores(): AsyncIterable<string> {
		try {
			const entries = await readdir(base_path, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.name.startsWith("_")) {
					yield entry.name;
				}
			}
		} catch {}
	}

	const metadata_storage: MetadataStorage = {
		async get(store_id, version) {
			const store_meta = await read_store_meta(store_id);
			return store_meta.get(version) ?? null;
		},

		async put(meta) {
			const store_meta = await read_store_meta(meta.store_id);
			store_meta.set(meta.version, meta);
			await write_store_meta(meta.store_id, store_meta);
		},

		async delete(store_id, version) {
			const store_meta = await read_store_meta(store_id);
			store_meta.delete(version);
			await write_store_meta(store_id, store_meta);
		},

		async *list(store_id) {
			if (store_id) {
				const store_meta = await read_store_meta(store_id);
				for (const meta of store_meta.values()) {
					yield meta;
				}
			} else {
				for await (const sid of list_all_stores()) {
					const store_meta = await read_store_meta(sid);
					for (const meta of store_meta.values()) {
						yield meta;
					}
				}
			}
		},

		async find_by_hash(store_id, content_hash) {
			const store_meta = await read_store_meta(store_id);
			for (const meta of store_meta.values()) {
				if (meta.content_hash === content_hash) {
					return meta;
				}
			}
			return null;
		},
	};

	const data_storage: DataStorage = {
		async get(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			if (!(await file.exists())) return null;
			return new Uint8Array(await file.arrayBuffer());
		},

		async put(data_key, data) {
			const path = data_path(data_key);
			await mkdir(dirname(path), { recursive: true });
			await Bun.write(path, data);
		},

		async delete(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			if (await file.exists()) {
				await file.delete();
			}
		},

		async exists(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			return file.exists();
		},
	};

	const metadata = create_metadata_client(metadata_storage, emit);
	const data = create_data_client(data_storage, emit);

	const file_path = join(base_path, "_observations.json");

	async function read_observations(): Promise<ObservationRow[]> {
		const file = Bun.file(file_path);
		if (!(await file.exists())) return [];
		try {
			return await file.json();
		} catch {
			return [];
		}
	}

	async function write_observations(rows: ObservationRow[]): Promise<void> {
		await Bun.write(file_path, JSON.stringify(rows, null, 2));
	}

	const storage = create_observations_storage({
		get_all: read_observations,
		set_all: write_observations,
		get_one: async (id) => {
			const rows = await read_observations();
			return rows.find((r) => r.id === id) ?? null;
		},
		add_one: async (row) => {
			const rows = await read_observations();
			rows.push(row);
			await write_observations(rows);
		},
		remove_one: async (id) => {
			const rows = await read_observations();
			const idx = rows.findIndex((r) => r.id === id);
			if (idx === -1) return false;
			rows.splice(idx, 1);
			await write_observations(rows);
			return true;
		},
	});
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event };
}
