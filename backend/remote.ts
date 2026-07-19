/**
 * @module Backends
 * @description Remote backend for laptop-side Cloudflare access — D1 over HTTP + R2 over S3.
 *
 * Assembles the shared drizzle storage layer (`backend/drizzle-storage.ts`)
 * over a D1 HTTP driver (`backend/remote-d1.ts`) and an R2 `DataStorage`
 * adapter (`backend/remote-r2.ts`) into a full `Backend`, reachable from a
 * laptop with only a Cloudflare API token — no Worker bindings required.
 *
 * Ships WITHOUT `apply_batch`: D1's HTTP `/raw` endpoint's multi-statement
 * calls are not a single transaction, so claiming atomicity here would be a
 * lie. `corpus.transaction()` falls back to its sequential best-effort path
 * for this backend (see `.plans/corpus-cli.html` architecture-decisions).
 *
 * This module is bun-only (transitively, via `backend/remote-r2.ts`'s use of
 * Bun's native S3Client) and is reachable ONLY through the `@f0rbit/corpus/remote`
 * entry point — never the main barrel — so Workers consumers never
 * transitively import Bun-only code.
 */

import { create_observations_client } from "../observations/index.js";
import type { Backend, EventHandler } from "../types.js";
import { create_emitter } from "../utils.js";
import { create_data_client } from "./base.js";
import { create_drizzle_observations_storage, create_drizzle_snapshot_metadata } from "./drizzle-storage.js";
import { create_d1_http_db, type D1HttpConfig } from "./remote-d1.js";
import { create_r2_data_storage, type R2S3Config } from "./remote-r2.js";

/**
 * Configuration for the remote backend.
 * @category Backends
 * @group Remote Backends
 */
export type RemoteBackendConfig = {
	/** Cloudflare account ID. */
	account_id: string;
	/** D1 database ID. */
	database_id: string;
	/** Cloudflare API token (Bearer auth for D1 HTTP). */
	api_token: string;
	/** R2 bucket connection details. */
	r2: {
		bucket: string;
		access_key_id: string;
		secret_access_key: string;
		/** Optional endpoint override (for testing). */
		endpoint?: string;
	};
	/** Optional D1 HTTP base URL override (for testing). */
	d1_base_url?: string;
	on_event?: EventHandler;
};

/**
 * Creates a remote backend using Cloudflare D1 (HTTP) + R2 (S3-compatible).
 * @category Backends
 * @group Storage Backends
 *
 * Laptop-side counterpart to `create_cloudflare_backend`: the same shared
 * drizzle query layer drives both, so a schema change can never let the two
 * D1 access paths drift. Metadata talks to D1 over the HTTP `/raw` endpoint
 * with a Bearer API token; data talks to R2 over its S3-compatible API via
 * Bun's native S3Client.
 *
 * No `apply_batch` — see the module docstring. `corpus.transaction()` still
 * works against this backend, just without atomicity guarantees.
 *
 * @param config - Connection details for D1 (HTTP) and R2 (S3)
 * @returns A Backend instance using remote D1 + R2 access
 *
 * @example
 * ```ts
 * const backend = create_remote_backend({
 *   account_id: env.CLOUDFLARE_ACCOUNT_ID,
 *   database_id: env.CORPUS_DATABASE_ID,
 *   api_token: env.CLOUDFLARE_API_TOKEN,
 *   r2: {
 *     bucket: "my-corpus-bucket",
 *     access_key_id: env.CORPUS_R2_ACCESS_KEY_ID,
 *     secret_access_key: env.CORPUS_R2_SECRET_ACCESS_KEY,
 *   },
 * })
 * ```
 *
 * @see create_cloudflare_backend - Workers-binding counterpart
 */
export function create_remote_backend(config: RemoteBackendConfig): Backend {
	const emit = create_emitter(config.on_event);

	const d1_config: D1HttpConfig = {
		account_id: config.account_id,
		database_id: config.database_id,
		api_token: config.api_token,
		base_url: config.d1_base_url,
	};
	const db = create_d1_http_db(d1_config);

	const metadata = create_drizzle_snapshot_metadata(db, emit);

	const r2_config: R2S3Config = {
		account_id: config.account_id,
		bucket: config.r2.bucket,
		access_key_id: config.r2.access_key_id,
		secret_access_key: config.r2.secret_access_key,
		endpoint: config.r2.endpoint,
	};
	const data = create_data_client(create_r2_data_storage(r2_config), emit);

	const observations_storage = create_drizzle_observations_storage(db);
	const observations = create_observations_client(observations_storage, metadata);

	return { metadata, data, observations, on_event: config.on_event };
}
