/**
 * @module Backend Base
 * @description Base abstraction layer for backend implementations.
 */

import type {
	MetadataClient,
	DataClient,
	SnapshotMeta,
	Result,
	CorpusError,
	CorpusEvent,
	ListOpts,
	DataHandle,
} from "../types.js";
import { ok, err } from "../types.js";
import { to_bytes, filter_snapshots } from "../utils.js";
import { first, to_fallback, try_catch_async } from "../result.js";
import { storage_error } from "./errors.js";

export type MetadataStorage = {
	get: (store_id: string, version: string) => Promise<SnapshotMeta | null>;
	put: (meta: SnapshotMeta) => Promise<void>;
	delete: (store_id: string, version: string) => Promise<void>;
	list: (store_id: string) => AsyncIterable<SnapshotMeta>;
	find_by_hash: (store_id: string, hash: string) => Promise<SnapshotMeta | null>;
};

/**
 * Adapter-side handle returned by `DataStorage.get`. Lives next to
 * `DataStorage` (not in `types.ts`) because it's part of the backend
 * extension surface — `types.ts:DataHandle` is the consumer-facing
 * shape exposed by `DataClient.get`.
 */
export type DataStorageHandle = {
	bytes: () => Promise<Uint8Array>;
	/** Optional native stream. If absent, `create_data_client` falls back to a one-chunk wrapper around `bytes()`. */
	stream?: () => ReadableStream<Uint8Array>;
	size?: number;
};

export type DataStorage = {
	get: (data_key: string) => Promise<DataStorageHandle | null>;
	put: (data_key: string, data: Uint8Array) => Promise<void>;
	delete: (data_key: string) => Promise<void>;
	exists: (data_key: string) => Promise<boolean>;
};

/**
 * Wraps a legacy bytes-returning storage in the new `DataStorage` shape.
 * Migration helper for custom backends written against the pre-0.4.0 contract:
 *
 * ```ts
 * create_data_client(wrap_bytes_storage(my_storage), emit)
 * ```
 *
 * The wrapped `get` produces a `DataStorageHandle` whose `bytes()` returns the
 * stored bytes and whose `stream()` wraps them in a one-chunk `ReadableStream`.
 */
export type BytesStorage = {
	get: (data_key: string) => Promise<Uint8Array | null>;
	put: (data_key: string, data: Uint8Array) => Promise<void>;
	delete: (data_key: string) => Promise<void>;
	exists: (data_key: string) => Promise<boolean>;
};

export function wrap_bytes_storage(storage: BytesStorage): DataStorage {
	return {
		async get(data_key) {
			const bytes = await storage.get(data_key);
			if (!bytes) return null;
			return {
				bytes: async () => bytes,
				stream: () => one_chunk_stream(bytes),
				size: bytes.byteLength,
			};
		},
		put: storage.put,
		delete: storage.delete,
		exists: storage.exists,
	};
}

function one_chunk_stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

type Emit = (event: CorpusEvent) => void;

export function create_metadata_client(storage: MetadataStorage, emit: Emit): MetadataClient {
	return {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			const meta = await storage.get(store_id, version);
			emit({ type: "meta_get", store_id, version, found: !!meta });
			if (!meta) {
				return err({ kind: "not_found", store_id, version });
			}
			return ok(meta);
		},

		async put(meta): Promise<Result<void, CorpusError>> {
			await storage.put(meta);
			emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
			return ok(undefined);
		},

		async delete(store_id, version): Promise<Result<void, CorpusError>> {
			await storage.delete(store_id, version);
			emit({ type: "meta_delete", store_id, version });
			return ok(undefined);
		},

		async *list(store_id, opts?: ListOpts): AsyncIterable<SnapshotMeta> {
			const all: SnapshotMeta[] = [];
			for await (const meta of storage.list(store_id)) {
				all.push(meta);
			}

			// storage.list yields insertion order; reversing before the stable sort makes ties newest-put-first
			const filtered = filter_snapshots(all.toReversed(), opts);
			let count = 0;
			for (const meta of filtered) {
				yield meta;
				count++;
			}
			emit({ type: "meta_list", store_id, count });
		},

		async get_latest(store_id, opts): Promise<Result<SnapshotMeta, CorpusError>> {
			let latest: SnapshotMeta | null = null;
			for await (const meta of storage.list(store_id)) {
				if (opts?.entity_key !== undefined && meta.entity_key !== opts.entity_key) continue;
				// >= : on equal created_at the later-inserted snapshot wins (storage.list is insertion order)
				if (!latest || meta.created_at >= latest.created_at) {
					latest = meta;
				}
			}

			if (!latest) {
				return err({ kind: "not_found", store_id, version: "latest" });
			}
			return ok(latest);
		},

		async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
			for await (const meta of storage.list("")) {
				const is_child = meta.parents.some((p) => p.store_id === parent_store_id && p.version === parent_version);
				if (is_child) yield meta;
			}
		},

		async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
			return storage.find_by_hash(store_id, content_hash);
		},
	};
}

function emit_failure<T>(emit: Emit, result: Result<T, CorpusError>): Result<T, CorpusError> {
	if (!result.ok) emit({ type: "error", error: result.error });
	return result;
}

export function create_data_client(storage: DataStorage, emit: Emit): DataClient {
	return {
		async get(data_key): Promise<Result<DataHandle, CorpusError>> {
			const fetched = emit_failure(emit, await try_catch_async(() => storage.get(data_key), storage_error("data.get")));
			if (!fetched.ok) return fetched;
			const handle = fetched.value;
			emit({
				type: "data_get",
				store_id: to_fallback(first(data_key.split("/")), data_key),
				version: data_key,
				found: !!handle,
			});

			if (!handle) {
				return err({ kind: "not_found", store_id: data_key, version: "" });
			}

			return ok({
				stream: handle.stream ?? (() => one_chunk_stream_lazy(handle.bytes)),
				bytes: handle.bytes,
			});
		},

		async put(data_key, input): Promise<Result<void, CorpusError>> {
			return emit_failure(
				emit,
				await try_catch_async(async () => {
					await storage.put(data_key, await to_bytes(input));
				}, storage_error("data.put")),
			);
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			return emit_failure(emit, await try_catch_async(() => storage.delete(data_key), storage_error("data.delete")));
		},

		async exists(data_key): Promise<boolean> {
			const checked = emit_failure(
				emit,
				await try_catch_async(() => storage.exists(data_key), storage_error("data.exists")),
			);
			return checked.ok && checked.value;
		},
	};
}

function one_chunk_stream_lazy(bytes: () => Promise<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream({
		async start(controller) {
			controller.enqueue(await bytes());
			controller.close();
		},
	});
}
