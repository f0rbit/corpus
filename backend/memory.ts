/**
 * @module Backends
 * @description In-memory storage backend for testing and development.
 */

import type { Backend, MetadataClient, DataClient, SnapshotMeta, ListOpts, Result, CorpusError, CorpusEvent, EventHandler } from "../types";
import { ok, err } from "../types";

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
	const on_event = options?.on_event;

	function emit(event: CorpusEvent) {
		on_event?.(event);
	}

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
			const matches: SnapshotMeta[] = [];

			for (const [key, meta] of meta_store) {
				if (!key.startsWith(prefix)) continue;
				if (opts?.before && meta.created_at >= opts.before) continue;
				if (opts?.after && meta.created_at <= opts.after) continue;
				if (opts?.tags?.length && !opts.tags.every(t => meta.tags?.includes(t))) continue;
				matches.push(meta);
			}

			matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

			const limit = opts?.limit ?? Infinity;
			let count = 0;
			for (const match of matches.slice(0, limit)) {
				yield match;
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
			let bytes: Uint8Array;

			if (input instanceof Uint8Array) {
				bytes = input;
			} else {
				const chunks: Uint8Array[] = [];
				const reader = input.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				bytes = concat_bytes(chunks);
			}

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

	return { metadata, data, on_event };
}

function concat_bytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}
