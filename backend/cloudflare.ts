/**
 * @module Backends
 * @description Cloudflare Workers storage backend using D1 and R2.
 */

import { and, desc, eq, gt, inArray, like, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { corpus_observations, create_observations_client, type ObservationsStorage, type StorageQueryOpts } from "../observations/index.js";
import { first, to_fallback, to_nullable } from "../result.js";
import { corpus_snapshots } from "../schema.js";
import type { Backend, BatchOp, CorpusError, DataClient, EventHandler, MetadataClient, Result, SnapshotMeta } from "../types.js";
import { err, ok } from "../types.js";
import { create_emitter, parse_snapshot_meta } from "../utils.js";

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

function create_cloudflare_storage(db: ReturnType<typeof drizzle>): ObservationsStorage {
	return {
		async put_row(row) {
			try {
				await db.insert(corpus_observations).values(row);
				return ok(row);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.put",
				});
			}
		},

		async get_row(id) {
			try {
				const rows = await db.select().from(corpus_observations).where(eq(corpus_observations.id, id)).limit(1);
				return ok(to_nullable(first(rows)));
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.get",
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
				const existing = await db.select().from(corpus_observations).where(eq(corpus_observations.id, id)).limit(1);

				if (existing.length === 0) {
					return ok(false);
				}

				await db.delete(corpus_observations).where(eq(corpus_observations.id, id));
				return ok(true);
			} catch (cause) {
				return err({
					kind: "storage_error",
					cause: cause as Error,
					operation: "observations.delete",
				});
			}
		},

		async delete_by_source(store_id, version, path) {
			try {
				const conditions = [eq(corpus_observations.source_store_id, store_id), eq(corpus_observations.source_version, version)];

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
					operation: "observations.delete_by_source",
				});
			}
		},
	};
}

/**
 * Creates a Cloudflare Workers storage backend using D1 and R2.
 * @category Backends
 * @group Storage Backends
 *
 * Uses D1 (SQLite) for metadata storage and R2 (object storage) for binary data.
 * Database migrations should be managed via Drizzle Kit using the exported
 * `corpus_snapshots` and `corpus_observations` schemas.
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
 * @see corpus_snapshots - Drizzle schema for snapshot metadata
 * @see corpus_observations - Drizzle schema for observations
 */
export function create_cloudflare_backend(config: CloudflareBackendConfig): Backend {
	const db = drizzle(config.d1);
	const { r2, on_event } = config;
	const emit = create_emitter(on_event);

	function snapshot_row_to_meta(row: typeof corpus_snapshots.$inferSelect): SnapshotMeta {
		return parse_snapshot_meta(row);
	}

	const metadata: MetadataClient = {
		async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
			try {
				const rows = await db
					.select()
					.from(corpus_snapshots)
					.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)))
					.limit(1);

				const row = to_nullable(first(rows));
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
				await meta_insert_stmt(meta);
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
				await meta_delete_stmt(store_id, version);
				emit({ type: "meta_delete", store_id, version });
				return ok(undefined);
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.delete" };
				emit({ type: "error", error });
				return err(error);
			}
		},

		async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
			const conditions = [eq(corpus_snapshots.store_id, store_id)];

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

			let rows: (typeof corpus_snapshots.$inferSelect)[];
			try {
				rows = await query;
			} catch (cause) {
				const error: CorpusError = { kind: "storage_error", cause: cause as Error, operation: "metadata.list" };
				emit({ type: "error", error });
				return;
			}

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

				const row = to_nullable(first(rows));
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

				const row = to_nullable(first(rows));
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
				emit({ type: "data_get", store_id: to_fallback(first(data_key.split("/")), data_key), version: data_key, found: !!object });

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

	function meta_insert_stmt(meta: SnapshotMeta) {
		const values = {
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
		};
		return db
			.insert(corpus_snapshots)
			.values(values)
			.onConflictDoUpdate({
				target: [corpus_snapshots.store_id, corpus_snapshots.version],
				set: {
					parents: values.parents,
					created_at: values.created_at,
					invoked_at: values.invoked_at,
					content_hash: values.content_hash,
					content_type: values.content_type,
					size_bytes: values.size_bytes,
					data_key: values.data_key,
					tags: values.tags,
				},
			});
	}

	function meta_delete_stmt(store_id: string, version: string) {
		return db
			.delete(corpus_snapshots)
			.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)));
	}

	function obs_insert_stmt(row: typeof corpus_observations.$inferInsert) {
		return db.insert(corpus_observations).values(row);
	}

	function obs_delete_stmt(id: string) {
		return db.delete(corpus_observations).where(eq(corpus_observations.id, id));
	}

	/**
	 * Apply a batch of ops atomically.
	 *
	 * Two-phase write: R2 data_put ops first (sequential, content-addressed so
	 * idempotent on retry), then a single D1 `db.batch()` for every metadata
	 * + observation op. D1's batch is a real SQLite transaction — all
	 * statements succeed or none commit.
	 *
	 * On R2 failure we abort before touching D1 — no partial metadata. R2
	 * objects already written remain as orphans. On D1 batch failure after
	 * all R2 writes succeeded, the R2 objects are also orphans. A follow-up
	 * `corpus.gc()` cleans them up by listing R2 objects not referenced by
	 * any live `data_key` in D1 — out of scope here, tracked in README.
	 *
	 * TODO: integration test against `wrangler dev` — repo convention is
	 * out-of-band manual testing for the Cloudflare backend, no D1/R2 mocks
	 * in the suite.
	 */
	async function apply_batch(ops: BatchOp[]): Promise<Result<void, CorpusError>> {
		// Step 1: R2 data_put ops, sequential to short-circuit on first failure.
		for (const op of ops) {
			if (op.type !== 'data_put') continue;
			try {
				await r2.put(op.data_key, op.bytes);
			} catch (cause) {
				return err({
					kind: 'transaction_aborted',
					reason: 'apply_batch_failed',
					cause: cause instanceof Error ? cause : new Error(String(cause)),
				});
			}
		}

		// Step 2: build prepared statements for metadata + observation ops.
		type Stmt =
			| ReturnType<typeof meta_insert_stmt>
			| ReturnType<typeof meta_delete_stmt>
			| ReturnType<typeof obs_insert_stmt>
			| ReturnType<typeof obs_delete_stmt>;
		const stmts: Stmt[] = [];
		for (const op of ops) {
			switch (op.type) {
				case 'meta_put':
					stmts.push(meta_insert_stmt(op.meta));
					break;
				case 'meta_delete':
					stmts.push(meta_delete_stmt(op.store_id, op.version));
					break;
				case 'observation_put':
					stmts.push(obs_insert_stmt(op.row));
					break;
				case 'observation_delete':
					stmts.push(obs_delete_stmt(op.id));
					break;
				case 'data_put':
					break;
			}
		}

		const [head, ...rest] = stmts;
		if (head === undefined) {
			return ok(undefined);
		}

		try {
			await db.batch([head, ...rest] as readonly [Stmt, ...Stmt[]]);
			return ok(undefined);
		} catch (cause) {
			return err({
				kind: 'transaction_aborted',
				reason: 'apply_batch_failed',
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			});
		}
	}

	return { metadata, data, observations, on_event, apply_batch };
}
