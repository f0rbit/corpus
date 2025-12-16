/**
 * @module Backends
 * @description File-system storage backend for local persistence.
 */

import type { Backend, MetadataClient, DataClient, SnapshotMeta, Result, CorpusError, EventHandler } from "../types";
import type { ObservationRow } from "../observations";
import { create_observations_client, create_observations_storage } from "../observations";
import { ok, err } from "../types";
import { to_bytes, create_emitter, filter_snapshots, parse_snapshot_meta } from "../utils";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

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

	const metadata: MetadataClient = {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			const store_meta = await read_store_meta(store_id);
			const meta = store_meta.get(version);
			emit({ type: "meta_get", store_id, version, found: !!meta });
			if (!meta) {
				return err({ kind: "not_found", store_id, version });
			}
			return ok(meta);
		},

		async put(meta): Promise<Result<void, CorpusError>> {
			const store_meta = await read_store_meta(meta.store_id);
			store_meta.set(meta.version, meta);
			await write_store_meta(meta.store_id, store_meta);
			emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
			return ok(undefined);
		},

		async delete(store_id, version): Promise<Result<void, CorpusError>> {
			const store_meta = await read_store_meta(store_id);
			store_meta.delete(version);
			await write_store_meta(store_id, store_meta);
			emit({ type: "meta_delete", store_id, version });
			return ok(undefined);
		},

		async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
			const store_meta = await read_store_meta(store_id);

			const filtered = filter_snapshots(Array.from(store_meta.values()), opts);
			let count = 0;
			for (const meta of filtered) {
				yield meta;
				count++;
			}
			emit({ type: "meta_list", store_id, count });
		},

		async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
			const store_meta = await read_store_meta(store_id);

			let latest: SnapshotMeta | null = null;
			for (const meta of store_meta.values()) {
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
			try {
				const entries = await readdir(base_path, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory() || entry.name.startsWith("_")) continue;

					const store_meta = await read_store_meta(entry.name);
					for (const meta of store_meta.values()) {
						const is_child = meta.parents.some(p => p.store_id === parent_store_id && p.version === parent_version);
						if (is_child) yield meta;
					}
				}
			} catch {}
		},

		async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
			const store_meta = await read_store_meta(store_id);
			for (const meta of store_meta.values()) {
				if (meta.content_hash === content_hash) {
					return meta;
				}
			}
			return null;
		},
	};

	const data: DataClient = {
		async get(data_key): Promise<Result<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> }, CorpusError>> {
			const path = data_path(data_key);
			const file = Bun.file(path);

			const found = await file.exists();
			emit({ type: "data_get", store_id: data_key.split("/")[0] ?? data_key, version: data_key, found });

			if (!found) {
				return err({ kind: "not_found", store_id: data_key, version: "" });
			}

			return ok({
				stream: () => file.stream(),
				bytes: async () => new Uint8Array(await file.arrayBuffer()),
			});
		},

		async put(data_key, input): Promise<Result<void, CorpusError>> {
			const path = data_path(data_key);
			await mkdir(dirname(path), { recursive: true });

			try {
				const bytes = await to_bytes(input)
				await Bun.write(path, bytes);
				return ok(undefined);
			} catch (cause) {
				return err({ kind: "storage_error", cause: cause as Error, operation: "put" });
			}
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			const path = data_path(data_key);
			try {
				const file = Bun.file(path);
				if (await file.exists()) {
					await file.delete();
				}
				return ok(undefined);
			} catch (cause) {
				return err({ kind: "storage_error", cause: cause as Error, operation: "delete" });
			}
		},

		async exists(data_key): Promise<boolean> {
			const path = data_path(data_key);
			const file = Bun.file(path);
			return file.exists();
		},
	};

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
			const rows = await read_observations()
			return rows.find(r => r.id === id) ?? null
		},
		add_one: async (row) => {
			const rows = await read_observations()
			rows.push(row)
			await write_observations(rows)
		},
		remove_one: async (id) => {
			const rows = await read_observations()
			const idx = rows.findIndex(r => r.id === id)
			if (idx === -1) return false
			rows.splice(idx, 1)
			await write_observations(rows)
			return true
		}
	})
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event };
}
