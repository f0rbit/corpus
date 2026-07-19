/**
 * @module Backends
 * @description Layered backend for caching and replication strategies.
 */

import type {
	Backend,
	BatchOp,
	MetadataClient,
	DataClient,
	SnapshotMeta,
	Result,
	CorpusError,
	DataHandle,
	ObservationsClient,
} from "../types.js";
import { ok, err } from "../types.js";
import { to_bytes } from "../utils.js";
import { first, to_nullable } from "../result.js";

export type LayeredBackendOptions = {
	read: Backend[];
	write: Backend[];
	list_strategy?: "merge" | "first";
};

/**
 * Creates a layered backend that combines multiple backends with read/write separation.
 * @category Backends
 * @group Composite Backends
 *
 * Read operations use fallback: tries each read backend in order until one succeeds.
 * Write operations use fanout: writes to all write backends (fails if any fail).
 *
 * Common use cases:
 * - **Caching**: Memory backend first for reads, file backend for persistence
 * - **Replication**: Write to multiple backends for redundancy
 * - **Migration**: Read from old + new backends, write only to new
 *
 * @param options - Configuration with `read` backends (tried in order), `write` backends (all receive writes), and optional `list_strategy` ('merge' or 'first')
 * @returns A Backend that delegates to the configured backends
 *
 * @example
 * ```ts
 * // Caching layer: memory cache with file persistence
 * const cache = create_memory_backend()
 * const storage = create_file_backend({ base_path: './data' })
 *
 * const backend = create_layered_backend({
 *   read: [cache, storage],   // Try cache first, fall back to disk
 *   write: [cache, storage],  // Write to both
 * })
 *
 * // Migration: read from old and new, write only to new
 * const backend = create_layered_backend({
 *   read: [newBackend, oldBackend],
 *   write: [newBackend],
 * })
 * ```
 */
export function create_layered_backend(options: LayeredBackendOptions): Backend {
	const { read, write, list_strategy = "merge" } = options;

	// Bottom write layer is the source of truth for both `apply_batch` and
	// `list_stores` — cache layers above it are read accelerators only.
	const bottom_write = write.at(-1);
	const list_stores: (() => AsyncIterable<string>) | undefined = bottom_write?.metadata.list_stores?.bind(
		bottom_write.metadata,
	);

	const metadata: MetadataClient = {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			for (const backend of read) {
				const result = await backend.metadata.get(store_id, version);
				if (result.ok) return result;
				if (result.error.kind !== "not_found") return result;
			}
			return err({ kind: "not_found", store_id, version });
		},

		async put(meta): Promise<Result<void, CorpusError>> {
			for (const backend of write) {
				const result = await backend.metadata.put(meta);
				if (!result.ok) return result;
			}
			return ok(undefined);
		},

		async delete(store_id, version): Promise<Result<void, CorpusError>> {
			for (const backend of write) {
				const result = await backend.metadata.delete(store_id, version);
				if (!result.ok && result.error.kind !== "not_found") return result;
			}
			return ok(undefined);
		},

		async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
			if (read.length === 0) return;

			if (list_strategy === "first") {
				const first_backend = to_nullable(first(read));
				if (!first_backend) return;
				yield* first_backend.metadata.list(store_id, opts);
				return;
			}

			const seen = new Set<string>();
			const all: SnapshotMeta[] = [];

			for (const backend of read) {
				for await (const meta of backend.metadata.list(store_id, opts)) {
					if (seen.has(meta.version)) continue;
					seen.add(meta.version);
					all.push(meta);
				}
			}

			all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

			const limit = opts?.limit ?? Infinity;
			for (const meta of all.slice(0, limit)) {
				yield meta;
			}
		},

		async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
			let latest: SnapshotMeta | null = null;

			for (const backend of read) {
				const result = await backend.metadata.get_latest(store_id);
				if (!result.ok) {
					if (result.error.kind !== "not_found") return result;
					continue;
				}
				if (!latest || result.value.created_at > latest.created_at) {
					latest = result.value;
				}
			}

			if (!latest) {
				return err({ kind: "not_found", store_id, version: "latest" });
			}
			return ok(latest);
		},

		async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
			const seen = new Set<string>();

			for (const backend of read) {
				for await (const meta of backend.metadata.get_children(parent_store_id, parent_version)) {
					const key = `${meta.store_id}:${meta.version}`;
					if (seen.has(key)) continue;
					seen.add(key);
					yield meta;
				}
			}
		},

		async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
			for (const backend of read) {
				const result = await backend.metadata.find_by_hash(store_id, content_hash);
				if (result) return result;
			}
			return null;
		},

		...(list_stores ? { list_stores } : {}),
	};

	const data: DataClient = {
		async get(data_key): Promise<Result<DataHandle, CorpusError>> {
			for (const backend of read) {
				const result = await backend.data.get(data_key);
				if (result.ok) return result;
				if (result.error.kind !== "not_found") return result;
			}
			return err({ kind: "not_found", store_id: data_key, version: "" });
		},

		async put(data_key, payload): Promise<Result<void, CorpusError>> {
			const [sole] = write;
			if (!sole) return ok(undefined);

			if (write.length === 1) {
				return sole.data.put(data_key, payload);
			}

			const bytes = await to_bytes(payload);
			for (const backend of write) {
				const result = await backend.data.put(data_key, bytes);
				if (!result.ok) return result;
			}
			return ok(undefined);
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			for (const backend of write) {
				const result = await backend.data.delete(data_key);
				if (!result.ok && result.error.kind !== "not_found") return result;
			}
			return ok(undefined);
		},

		async exists(data_key): Promise<boolean> {
			for (const backend of read) {
				if (await backend.data.exists(data_key)) return true;
			}
			return false;
		},
	};

	const observations = create_layered_observations_client(read, write);

	// Forward apply_batch to the bottom write layer (last entry in `write`,
	// computed above alongside `list_stores`). Cache layers above it are read
	// accelerators only; transactional commits land at the bottom and the
	// cache fills lazily on subsequent reads. Only present if a bottom write
	// layer exists and supports apply_batch — otherwise the layered backend
	// hides the method, falling back to the sequential best-effort path in
	// `corpus.transaction()`.
	const apply_batch: ((ops: BatchOp[]) => Promise<Result<void, CorpusError>>) | undefined =
		bottom_write?.apply_batch?.bind(bottom_write);

	return {
		metadata,
		data,
		...(observations ? { observations } : {}),
		...(apply_batch ? { apply_batch } : {}),
	};
}

function create_layered_observations_client(
	read_layers: Backend[],
	write_layers: Backend[],
): ObservationsClient | undefined {
	const primary = read_layers.map((l) => l.observations).find((o) => o !== undefined);
	const write_clients = write_layers.map((l) => l.observations).filter((o) => o !== undefined);

	if (!primary && write_clients.length === 0) {
		return undefined;
	}

	return {
		async put(type, opts) {
			const [head, ...rest] = write_clients;
			if (!head) {
				return err({ kind: "invalid_config", message: "No write layers support observations" });
			}
			let result = await head.put(type, opts);
			if (!result.ok) return result;
			for (const client of rest) {
				result = await client.put(type, opts);
				if (!result.ok) return result;
			}
			return result;
		},

		async get(id) {
			if (!primary) {
				return err({ kind: "observation_not_found", id });
			}
			return primary.get(id);
		},

		async *query(opts) {
			if (!primary) return;
			yield* primary.query(opts);
		},

		async *query_meta(opts) {
			if (!primary) return;
			yield* primary.query_meta(opts);
		},

		async delete(id) {
			const [head, ...rest] = write_clients;
			if (!head) {
				return err({ kind: "observation_not_found", id });
			}
			let result = await head.delete(id);
			for (const client of rest) {
				result = await client.delete(id);
			}
			return result;
		},

		async delete_by_source(source) {
			let total = 0;
			for (const client of write_clients) {
				const result = await client.delete_by_source(source);
				if (result.ok) total += result.value;
			}
			return ok(total);
		},

		async is_stale(pointer) {
			if (!primary) return false;
			return primary.is_stale(pointer);
		},
	};
}
