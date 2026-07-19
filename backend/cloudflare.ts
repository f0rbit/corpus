/**
 * @module Backends
 * @description Cloudflare Workers storage backend using D1 and R2.
 */

import { drizzle } from "drizzle-orm/d1";
import { create_observations_client } from "../observations/index.js";
import { first, to_fallback, try_catch_async } from "../result.js";
import type { Backend, BatchOp, CorpusError, DataClient, EventHandler, MetadataClient, Result } from "../types.js";
import { err, ok } from "../types.js";
import { create_emitter } from "../utils.js";
import {
	create_drizzle_observations_storage,
	create_drizzle_snapshot_metadata,
	meta_delete_stmt,
	meta_insert_stmt,
	obs_delete_stmt,
	obs_insert_stmt,
	storage_error,
	to_error,
} from "./drizzle-storage.js";

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

	const metadata: MetadataClient = create_drizzle_snapshot_metadata(db, emit);

	const data: DataClient = {
		async get(
			data_key,
		): Promise<Result<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> }, CorpusError>> {
			const fetched = await try_catch_async(() => r2.get(data_key), storage_error("data.get"));
			if (!fetched.ok) {
				emit({ type: "error", error: fetched.error });
				return fetched;
			}

			const object = fetched.value;
			emit({
				type: "data_get",
				store_id: to_fallback(first(data_key.split("/")), data_key),
				version: data_key,
				found: !!object,
			});

			if (!object) {
				return err({ kind: "not_found", store_id: data_key, version: "" });
			}

			return ok({
				stream: () => object.body,
				bytes: async () => new Uint8Array(await object.arrayBuffer()),
			});
		},

		async put(data_key, input): Promise<Result<void, CorpusError>> {
			const result = await try_catch_async(() => r2.put(data_key, input), storage_error("data.put"));
			if (!result.ok) {
				emit({ type: "error", error: result.error });
				return result;
			}
			return ok(undefined);
		},

		async delete(data_key): Promise<Result<void, CorpusError>> {
			const result = await try_catch_async(() => r2.delete(data_key), storage_error("data.delete"));
			if (!result.ok) {
				emit({ type: "error", error: result.error });
				return result;
			}
			return ok(undefined);
		},

		async exists(data_key): Promise<boolean> {
			const head = await try_catch_async(
				() => r2.head(data_key),
				() => null,
			);
			return head.ok ? head.value !== null : false;
		},
	};

	const storage = create_drizzle_observations_storage(db);
	const observations = create_observations_client(storage, metadata);

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
	 * Statement builders (`meta_insert_stmt`, etc.) come from
	 * `backend/drizzle-storage.ts` — the same ones `create_drizzle_snapshot_metadata`
	 * and `create_drizzle_observations_storage` use, so a batched op and its
	 * non-transactional equivalent can never drift. `db.batch()` itself stays
	 * here: it's D1-specific and not part of the shared drizzle layer.
	 *
	 * Covered by the contract suite + tests/integration/cloudflare-backend.test.ts
	 * running against in-memory platform fakes (tests/fakes/cloudflare.ts).
	 * Real-platform smoke via `wrangler dev` remains out-of-band.
	 */
	async function apply_batch(ops: BatchOp[]): Promise<Result<void, CorpusError>> {
		// Step 1: R2 data_put ops, sequential to short-circuit on first failure.
		for (const op of ops) {
			if (op.type !== "data_put") continue;
			const put_result = await try_catch_async(
				() => r2.put(op.data_key, op.bytes),
				(cause): CorpusError => ({ kind: "transaction_aborted", reason: "apply_batch_failed", cause: to_error(cause) }),
			);
			if (!put_result.ok) return put_result;
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
				case "meta_put":
					stmts.push(meta_insert_stmt(db, op.meta));
					break;
				case "meta_delete":
					stmts.push(meta_delete_stmt(db, op.store_id, op.version));
					break;
				case "observation_put":
					stmts.push(obs_insert_stmt(db, op.row));
					break;
				case "observation_delete":
					stmts.push(obs_delete_stmt(db, op.id));
					break;
				case "data_put":
					break;
			}
		}

		const [head, ...rest] = stmts;
		if (head === undefined) {
			return ok(undefined);
		}

		return try_catch_async(
			async () => {
				await db.batch([head, ...rest] as readonly [Stmt, ...Stmt[]]);
			},
			(cause): CorpusError => ({ kind: "transaction_aborted", reason: "apply_batch_failed", cause: to_error(cause) }),
		);
	}

	return { metadata, data, observations, on_event, apply_batch };
}
