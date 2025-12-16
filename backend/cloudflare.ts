/**
 * @module Backends
 * @description Cloudflare Workers storage backend using D1 and R2.
 */

import { eq, and, desc, lt, gt, like, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Backend, MetadataClient, DataClient, SnapshotMeta, Result, CorpusError, EventHandler } from "../types";
import { create_emitter, parse_snapshot_meta } from "../utils";
import { ok, err } from "../types";
import { corpus_snapshots } from "../schema";
import { corpus_observations, type ObservationRow, type ObservationsStorage, type StorageQueryOpts, create_observations_client } from "../observations";

type D1Database = { prepare: (sql: string) => unknown };
type R2Bucket = {
	get: (key: string) => Promise<{ body: ReadableStream<Uint8Array>; arrayBuffer: () => Promise<ArrayBuffer> } | null>;
	put: (key: string, data: ReadableStream<Uint8Array> | Uint8Array) => Promise<void>;
	delete: (key: string) => Promise<void>;
	head: (key: string) => Promise<{ key: string } | null>;
};

export type CloudflareBackendConfig = {
	d1: D1Database;
	r2: R2Bucket;
	on_event?: EventHandler;
};

function create_cloudflare_storage(
	db: ReturnType<typeof drizzle>
): ObservationsStorage {
	return {
		async put_row(row) {
			try {
				await db.insert(corpus_observations).values(row);
				return ok(row);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.put"
				});
			}
		},

		async get_row(id) {
			try {
				const rows = await db
					.select()
					.from(corpus_observations)
					.where(eq(corpus_observations.id, id))
					.limit(1);
				return ok(rows[0] ?? null);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.get"
				});
			}
		},

		async *query_rows(opts: StorageQueryOpts = {}) {
			const conditions: ReturnType<typeof eq>[] = [];

			if (opts.type) {
				if (Array.isArray(opts.type)) {
					conditions.push(inArray(corpus_observations.type, opts.type));
				} else {
					conditions.push(eq(corpus_observations.type, opts.type));
				}
			}
			if (opts.source_store_id) {
				conditions.push(eq(corpus_observations.source_store_id, opts.source_store_id));
			}
			if (opts.source_version) {
				conditions.push(eq(corpus_observations.source_version, opts.source_version));
			}
			if (opts.source_prefix) {
				conditions.push(like(corpus_observations.source_version, `${opts.source_prefix}%`));
			}
			if (opts.created_after) {
				conditions.push(gt(corpus_observations.created_at, opts.created_after));
			}
			if (opts.created_before) {
				conditions.push(lt(corpus_observations.created_at, opts.created_before));
			}
			if (opts.observed_after) {
				conditions.push(gt(corpus_observations.observed_at, opts.observed_after));
			}
			if (opts.observed_before) {
				conditions.push(lt(corpus_observations.observed_at, opts.observed_before));
			}

			let query = db
				.select()
				.from(corpus_observations)
				.where(conditions.length > 0 ? and(...conditions) : undefined)
				.orderBy(desc(corpus_observations.created_at));

			if (opts.limit) {
				query = query.limit(opts.limit) as typeof query;
			}

			const rows = await query;
			for (const row of rows) {
				yield row;
			}
		},

		async delete_row(id) {
			try {
				const existing = await db
					.select()
					.from(corpus_observations)
					.where(eq(corpus_observations.id, id))
					.limit(1);

				if (existing.length === 0) {
					return ok(false);
				}

				await db.delete(corpus_observations).where(eq(corpus_observations.id, id));
				return ok(true);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.delete"
				});
			}
		},

		async delete_by_source(store_id, version, path) {
			try {
				const conditions = [
					eq(corpus_observations.source_store_id, store_id),
					eq(corpus_observations.source_version, version)
				];

				if (path !== undefined) {
					conditions.push(eq(corpus_observations.source_path, path));
				}

				const toDelete = await db
					.select()
					.from(corpus_observations)
					.where(and(...conditions));

				const count = toDelete.length;

				if (count > 0) {
					await db.delete(corpus_observations).where(and(...conditions));
				}

				return ok(count);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.delete_by_source"
				});
			}
		}
	};
}

/**
 * Creates a Cloudflare Workers storage backend using D1 and R2.
 * @category Backends
 * @group Storage Backends
 *
 * Uses D1 (SQLite) for metadata storage and R2 (object storage) for binary data.
 * Requires running `CORPUS_MIGRATION_SQL` on the D1 database before first use.
 *
 * This backend is designed for production use in Cloudflare Workers environments,
 * providing durable, globally distributed storage.
 *
 * @param config - Configuration with `d1` (D1 database), `r2` (R2 bucket), and optional `on_event` handler
 * @returns A Backend instance using Cloudflare D1 + R2
 *
 * @example
 * ```ts
 * // In a Cloudflare Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const backend = create_cloudflare_backend({
 *       d1: env.CORPUS_DB,
 *       r2: env.CORPUS_BUCKET
 *     })
 *
 *     const corpus = create_corpus()
 *       .with_backend(backend)
 *       .with_store(define_store('cache', json_codec(CacheSchema)))
 *       .build()
 *
 *     // Use corpus...
 *   }
 * }
 * ```
 *
 * @see CORPUS_MIGRATION_SQL for required database setup
 */
export function create_cloudflare_backend(config: CloudflareBackendConfig): Backend {
	const db = drizzle(config.d1);
	const { r2, on_event } = config;
	const emit = create_emitter(on_event);

	function snapshot_row_to_meta(row: typeof corpus_snapshots.$inferSelect): SnapshotMeta {
		return parse_snapshot_meta(row)
	}

	const metadata: MetadataClient = {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			try {
				const rows = await db
					.select()
					.from(corpus_snapshots)
					.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)))
					.limit(1);

				const row = rows[0];
				emit({ type: "meta_get", store_id, version, found: !!row });

				if (!row) {
					return err({ kind: "not_found", store_id, version });
				}
				return ok(snapshot_row_to_meta(row));
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.get" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async put(meta): Promise<Result<void, CorpusError>> {
			try {
				await db
					.insert(corpus_snapshots)
					.values({
						store_id: meta.store_id,
						version: meta.version,
						parents: JSON.stringify(meta.parents),
						created_at: meta.created_at.toISOString(),
						invoked_at: meta.invoked_at?.toISOString() ?? null,
						content_hash: meta.content_hash,
						content_type: meta.content_type,
						size_bytes: meta.size_bytes,
						data_key: meta.data_key,
						tags: meta.tags ? JSON.stringify(meta.tags) : null,
					})
					.onConflictDoUpdate({
						target: [corpus_snapshots.store_id, corpus_snapshots.version],
						set: {
							parents: JSON.stringify(meta.parents),
							created_at: meta.created_at.toISOString(),
							invoked_at: meta.invoked_at?.toISOString() ?? null,
							content_hash: meta.content_hash,
							content_type: meta.content_type,
							size_bytes: meta.size_bytes,
							data_key: meta.data_key,
							tags: meta.tags ? JSON.stringify(meta.tags) : null,
						},
					});

				emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
				return ok(undefined);
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.put" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async delete(store_id, version): Promise<Result<void, CorpusError>> {
			try {
				await db.delete(corpus_snapshots).where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)));

				emit({ type: "meta_delete", store_id, version });
				return ok(undefined);
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.delete" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
			const conditions = [like(corpus_snapshots.store_id, `${store_id}%`)];

			if (opts?.before) {
				conditions.push(lt(corpus_snapshots.created_at, opts.before.toISOString()));
			}
			if (opts?.after) {
				conditions.push(gt(corpus_snapshots.created_at, opts.after.toISOString()));
			}

			let query = db
				.select()
				.from(corpus_snapshots)
				.where(and(...conditions))
				.orderBy(desc(corpus_snapshots.created_at));

			if (opts?.limit) {
				query = query.limit(opts.limit) as typeof query;
			}

			const rows = await query;
			let count = 0;

			for (const row of rows) {
				const meta = snapshot_row_to_meta(row);

				if (opts?.tags?.length && !opts.tags.every(t => meta.tags?.includes(t))) {
					continue;
				}

				yield meta;
				count++;
			}

			emit({ type: "meta_list", store_id, count });
		},

		async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
			try {
				const rows = await db.select().from(corpus_snapshots).where(eq(corpus_snapshots.store_id, store_id)).orderBy(desc(corpus_snapshots.created_at)).limit(1);

				const row = rows[0];
				if (!row) {
					return err({ kind: "not_found", store_id, version: "latest" });
				}
				return ok(snapshot_row_to_meta(row));
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.get_latest" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
			const rows = await db
				.select()
				.from(corpus_snapshots)
				.where(
					sql`EXISTS (
            SELECT 1 FROM json_each(${corpus_snapshots.parents}) 
            WHERE json_extract(value, '$.store_id') = ${parent_store_id}
              AND json_extract(value, '$.version') = ${parent_version}
          )`
				);

			for (const row of rows) {
				yield snapshot_row_to_meta(row);
			}
		},

		async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
			try {
				const rows = await db
					.select()
					.from(corpus_snapshots)
					.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.content_hash, content_hash)))
					.limit(1);

				const row = rows[0];
				return row ? snapshot_row_to_meta(row) : null;
			} catch {
				return null;
			}
		},
	};

	const data: DataClient = {
		async get(data_key): Promise<Result<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> }, CorpusError>> {
			try {
				const object = await r2.get(data_key);
				emit({ type: "data_get", store_id: data_key.split("/")[0] ?? data_key, version: data_key, found: !!object });

				if (!object) {
					return err({ kind: "not_found", store_id: data_key, version: "" });
				}

				return ok({
					stream: () => object.body,
					bytes: async () => new Uint8Array(await object.arrayBuffer()),
				});
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "data.get" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async put(data_key, input): Promise<Result<void, CorpusError>> {
			try {
				await r2.put(data_key, input);
				return ok(undefined);
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "data.put" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			try {
				await r2.delete(data_key);
				return ok(undefined);
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "data.delete" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async exists(data_key): Promise<boolean> {
			try {
				const head = await r2.head(data_key);
				return head !== null;
			} catch {
				return false;
			}
		},
	};

	const storage = create_cloudflare_storage(db);
	const observations = create_observations_client(storage, metadata);

	return { metadata, data, observations, on_event };
}
