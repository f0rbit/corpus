/**
 * @module Backends
 * @description Shared Drizzle query layer for D1-compatible SQLite databases.
 *
 * `backend/cloudflare.ts` (Workers D1 binding) and the upcoming HTTP-based
 * remote backend both drive `corpus_snapshots` / `corpus_observations`
 * through the same `BaseSQLiteDatabase<"async", ...>` query surface. This
 * module owns that query layer once so `schema.ts` stays the only SQL shape
 * and the two backends can never drift.
 *
 * `db.batch()` is intentionally NOT here — it's D1-specific (a real SQLite
 * transaction) and stays local to `backend/cloudflare.ts`'s `apply_batch`.
 * The statement builders exported below (`meta_insert_stmt`, etc.) exist so
 * that caller can build the same insert/delete queries this module uses
 * internally, then batch them itself.
 */

import { and, desc, eq, gt, inArray, like, lt, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { corpus_observations, type ObservationsStorage, type StorageQueryOpts } from "../observations/index.js";
import { first, to_fallback, to_nullable, try_catch_async } from "../result.js";
import { corpus_snapshots } from "../schema.js";
import type { CorpusError, CorpusEvent, ListOpts, MetadataClient, SnapshotMeta } from "../types.js";
import { err, ok } from "../types.js";
import { parse_snapshot_meta } from "../utils.js";

/**
 * Narrowest generic drizzle database type both `drizzle-orm/d1` and
 * `drizzle-orm/sqlite-proxy` databases satisfy structurally — both extend
 * `BaseSQLiteDatabase<"async", TRunResult, TSchema>`, differing only in
 * `TRunResult` (`D1Result` vs `SqliteRemoteResult`). We never inspect
 * `TRunResult` here; it's threaded through generically so callers that DO
 * care (D1's `.batch()`, kept local to `backend/cloudflare.ts`) stay
 * concretely typed from their own `db` binding.
 */
export type DrizzleDb<TRunResult = unknown> = BaseSQLiteDatabase<"async", TRunResult, Record<string, never>>;

type Emit = (event: CorpusEvent) => void;

function to_error(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function storage_error(operation: string): (cause: unknown) => CorpusError {
	return (cause) => ({ kind: "storage_error", cause: to_error(cause), operation });
}

function snapshot_row_to_meta(row: typeof corpus_snapshots.$inferSelect): SnapshotMeta {
	return parse_snapshot_meta(row);
}

/** Shared insert-or-update statement for a `corpus_snapshots` row. Used by both `create_drizzle_snapshot_metadata`'s `put` and `backend/cloudflare.ts`'s `apply_batch`. */
export function meta_insert_stmt<TRunResult>(db: DrizzleDb<TRunResult>, meta: SnapshotMeta) {
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

/** Shared delete statement for a `corpus_snapshots` row. Used by both `create_drizzle_snapshot_metadata`'s `delete` and `backend/cloudflare.ts`'s `apply_batch`. */
export function meta_delete_stmt<TRunResult>(db: DrizzleDb<TRunResult>, store_id: string, version: string) {
	return db
		.delete(corpus_snapshots)
		.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)));
}

/** Shared insert statement for a `corpus_observations` row. Used by `backend/cloudflare.ts`'s `apply_batch` (the non-batched `create_drizzle_observations_storage.put_row` builds its own insert inline). */
export function obs_insert_stmt<TRunResult>(db: DrizzleDb<TRunResult>, row: typeof corpus_observations.$inferInsert) {
	return db.insert(corpus_observations).values(row);
}

/** Shared delete statement for a `corpus_observations` row. Used by `backend/cloudflare.ts`'s `apply_batch` (the non-batched `create_drizzle_observations_storage.delete_row` builds its own delete inline). */
export function obs_delete_stmt<TRunResult>(db: DrizzleDb<TRunResult>, id: string) {
	return db.delete(corpus_observations).where(eq(corpus_observations.id, id));
}

/**
 * Builds the full `MetadataClient` implementation over `corpus_snapshots`,
 * generic over any async drizzle SQLite database (D1 or sqlite-proxy).
 *
 * @category Backends
 * @group Storage Backends
 */
export function create_drizzle_snapshot_metadata<TRunResult>(db: DrizzleDb<TRunResult>, emit: Emit): MetadataClient {
	return {
		async get(store_id, version) {
			const lookup = await try_catch_async(async () => {
				const rows = await db
					.select()
					.from(corpus_snapshots)
					.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.version, version)))
					.limit(1);

				const row = to_nullable(first(rows));
				return row ? snapshot_row_to_meta(row) : null;
			}, storage_error("metadata.get"));

			if (!lookup.ok) {
				emit({ type: "error", error: lookup.error });
				return lookup;
			}
			emit({ type: "meta_get", store_id, version, found: !!lookup.value });
			if (!lookup.value) {
				return err({ kind: "not_found", store_id, version });
			}
			return ok(lookup.value);
		},

		async put(meta) {
			const result = await try_catch_async(async () => {
				await meta_insert_stmt(db, meta);
			}, storage_error("metadata.put"));
			if (!result.ok) {
				emit({ type: "error", error: result.error });
				return result;
			}
			emit({ type: "meta_put", store_id: meta.store_id, version: meta.version });
			return ok(undefined);
		},

		async delete(store_id, version) {
			const result = await try_catch_async(async () => {
				await meta_delete_stmt(db, store_id, version);
			}, storage_error("metadata.delete"));
			if (!result.ok) {
				emit({ type: "error", error: result.error });
				return result;
			}
			emit({ type: "meta_delete", store_id, version });
			return ok(undefined);
		},

		async *list(store_id, opts?: ListOpts) {
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

			const rows = await try_catch_async(() => query, storage_error("metadata.list"));
			if (!rows.ok) {
				emit({ type: "error", error: rows.error });
				return;
			}

			let count = 0;

			for (const row of rows.value) {
				const meta = snapshot_row_to_meta(row);

				if (opts?.tags?.length && !opts.tags.every((t) => meta.tags?.includes(t))) {
					continue;
				}

				yield meta;
				count++;
			}

			emit({ type: "meta_list", store_id, count });
		},

		async get_latest(store_id) {
			const lookup = await try_catch_async(async () => {
				const rows = await db
					.select()
					.from(corpus_snapshots)
					.where(eq(corpus_snapshots.store_id, store_id))
					.orderBy(desc(corpus_snapshots.created_at))
					.limit(1);

				const row = to_nullable(first(rows));
				return row ? snapshot_row_to_meta(row) : null;
			}, storage_error("metadata.get_latest"));

			if (!lookup.ok) {
				emit({ type: "error", error: lookup.error });
				return lookup;
			}
			if (!lookup.value) {
				return err({ kind: "not_found", store_id, version: "latest" });
			}
			return ok(lookup.value);
		},

		async *get_children(parent_store_id, parent_version) {
			const rows = await db
				.select()
				.from(corpus_snapshots)
				.where(
					sql`EXISTS (
            SELECT 1 FROM json_each(${corpus_snapshots.parents})
            WHERE json_extract(value, '$.store_id') = ${parent_store_id}
              AND json_extract(value, '$.version') = ${parent_version}
          )`,
				);

			for (const row of rows) {
				yield snapshot_row_to_meta(row);
			}
		},

		async find_by_hash(store_id, content_hash) {
			const lookup = await try_catch_async(
				async () => {
					const rows = await db
						.select()
						.from(corpus_snapshots)
						.where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.content_hash, content_hash)))
						.limit(1);

					const row = to_nullable(first(rows));
					return row ? snapshot_row_to_meta(row) : null;
				},
				() => null,
			);
			return to_fallback(lookup, null);
		},

		async *list_stores() {
			const rows = await try_catch_async(
				() => db.selectDistinct({ store_id: corpus_snapshots.store_id }).from(corpus_snapshots),
				storage_error("metadata.list_stores"),
			);
			if (!rows.ok) {
				emit({ type: "error", error: rows.error });
				return;
			}

			for (const store_id of rows.value.map((r) => r.store_id).toSorted()) {
				yield store_id;
			}
		},
	};
}

/**
 * Builds the `ObservationsStorage` implementation over `corpus_observations`,
 * generic over any async drizzle SQLite database (D1 or sqlite-proxy).
 *
 * @category Backends
 * @group Storage Backends
 */
export function create_drizzle_observations_storage<TRunResult>(db: DrizzleDb<TRunResult>): ObservationsStorage {
	return {
		async put_row(row) {
			const result = await try_catch_async(async () => {
				await db.insert(corpus_observations).values(row);
			}, storage_error("observations.put"));
			if (!result.ok) return result;
			return ok(row);
		},

		async get_row(id) {
			return try_catch_async(async () => {
				const rows = await db.select().from(corpus_observations).where(eq(corpus_observations.id, id)).limit(1);
				return to_nullable(first(rows));
			}, storage_error("observations.get"));
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
			return try_catch_async(async () => {
				const existing = await db.select().from(corpus_observations).where(eq(corpus_observations.id, id)).limit(1);

				if (existing.length === 0) {
					return false;
				}

				await db.delete(corpus_observations).where(eq(corpus_observations.id, id));
				return true;
			}, storage_error("observations.delete"));
		},

		async delete_by_source(store_id, version, path) {
			return try_catch_async(async () => {
				const conditions = [
					eq(corpus_observations.source_store_id, store_id),
					eq(corpus_observations.source_version, version),
				];

				if (path !== undefined) {
					conditions.push(eq(corpus_observations.source_path, path));
				}

				const to_delete = await db
					.select()
					.from(corpus_observations)
					.where(and(...conditions));

				const count = to_delete.length;

				if (count > 0) {
					await db.delete(corpus_observations).where(and(...conditions));
				}

				return count;
			}, storage_error("observations.delete_by_source"));
		},
	};
}

export { storage_error, to_error };
