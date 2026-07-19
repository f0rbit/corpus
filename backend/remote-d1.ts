/**
 * @module Remote D1 Backend
 * @description D1 HTTP driver for remote Cloudflare access from laptops.
 *
 * Connects to Cloudflare's D1 REST API via Bearer token authentication,
 * wrapping parameterized SQL queries in the sqlite-proxy callback pattern
 * so the shared drizzle storage layer can drive both Workers-binding D1
 * and HTTP-based remote backends interchangeably.
 */

import { drizzle } from "drizzle-orm/sqlite-proxy";
import { z } from "zod";
import type { DrizzleDb } from "./drizzle-storage.js";

/**
 * Configuration for remote D1 HTTP access.
 * @category Backends
 * @group Remote Backends
 */
export type D1HttpConfig = {
	/** Cloudflare account ID */
	account_id: string;
	/** D1 database ID */
	database_id: string;
	/** Cloudflare API token (Bearer auth) */
	api_token: string;
	/** Optional base URL override (for testing) */
	base_url?: string;
};

/**
 * D1 HTTP error structure from the Cloudflare API response.
 */
const d1_http_error_schema = z.object({
	code: z.number(),
	message: z.string(),
});

/**
 * Single result object from D1's /raw endpoint response.
 */
const d1_http_result_schema = z.object({
	success: z.boolean(),
	meta: z.object({}).optional(),
	results: z
		.object({
			columns: z.array(z.string()),
			rows: z.array(z.array(z.unknown())),
		})
		.optional(),
	error: z.string().optional(),
});

/**
 * Full Cloudflare API envelope structure for D1 HTTP responses.
 * Exported for use by test fakes.
 * @category Backends
 * @group Remote Backends
 */
export const d1_http_response_schema = z.object({
	success: z.boolean(),
	errors: z.array(d1_http_error_schema),
	result: z.array(d1_http_result_schema),
	messages: z.array(z.string()).optional(),
});

export type D1HttpResponse = z.infer<typeof d1_http_response_schema>;

/**
 * Compute the D1 HTTP endpoint URL for a given config.
 * Exported for testability (so tests can override base_url).
 * @category Backends
 * @group Remote Backends
 */
export function d1_endpoint_url(config: D1HttpConfig): string {
	const base = config.base_url ?? "https://api.cloudflare.com/client/v4";
	return `${base}/accounts/${config.account_id}/d1/database/${config.database_id}/raw`;
}

/**
 * Creates a drizzle database connected to Cloudflare D1 via HTTP.
 *
 * The returned database can be passed to `create_drizzle_snapshot_metadata`
 * and `create_drizzle_observations_storage` (the same functions used by the
 * Workers-binding Cloudflare backend), allowing laptop-side remote access
 * with only a Bearer API token.
 *
 * @category Backends
 * @group Remote Backends
 * @param config - D1 HTTP configuration
 * @returns A drizzle database instance
 *
 * @example
 * ```ts
 * const db = create_d1_http_db({
 *   account_id: env.CLOUDFLARE_ACCOUNT_ID,
 *   database_id: env.CORPUS_DATABASE_ID,
 *   api_token: env.CLOUDFLARE_API_TOKEN,
 * })
 *
 * const metadata = create_drizzle_snapshot_metadata(db, emit)
 * ```
 */
export function create_d1_http_db(config: D1HttpConfig): DrizzleDb {
	const endpoint = d1_endpoint_url(config);

	// Intentional throw inside the sqlite-proxy callback boundary.
	// Drizzle's proxy contract expects throw on failure; the calling layer
	// (shared drizzle storage) wraps this in try_catch_async and converts to Result.
	// This is the sanctioned callback boundary (documented in AGENTS.md and the
	// eslint.config.ts override for this file — no inline disables here).
	async function proxy_callback(
		sql: string,
		params: unknown[],
		method: "get" | "all" | "run" | "values",
	): Promise<{ rows: unknown[][] }> {
		const request_body = {
			sql,
			params,
		};

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.api_token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request_body),
			});
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e));
			throw new Error(`D1 HTTP request failed: ${error.message}`, { cause: e });
		}

		// Handle non-2xx status codes
		if (!response.ok) {
			throw new Error(`D1 HTTP error ${String(response.status)}: ${response.statusText}`);
		}

		let parsed_response: unknown;
		try {
			const json: unknown = await response.json();
			parsed_response = json;
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e));
			throw new Error(`Failed to parse D1 HTTP response: ${error.message}`, { cause: e });
		}

		// Validate against Zod schema (f0rbit/require-schema-at-boundary)
		const schema_result = d1_http_response_schema.safeParse(parsed_response);
		if (!schema_result.success) {
			throw new Error(`Invalid D1 HTTP response structure: ${schema_result.error.message}`);
		}

		const envelope = schema_result.data;

		// Check success flag (CF returns 200 with success:false for SQL errors)
		if (!envelope.success || envelope.errors.length > 0) {
			const error_message = envelope.errors.map((e) => e.message).join("; ") || "Unknown error";
			throw new Error(`D1 SQL error: ${error_message}`);
		}

		// Extract the results from the envelope
		if (envelope.result.length === 0) {
			throw new Error("D1 HTTP response missing result");
		}

		const result_obj = envelope.result[0];
		if (!result_obj || !result_obj.success) {
			throw new Error(`D1 statement failed: ${result_obj?.error || "Unknown error"}`);
		}

		const results = result_obj.results;
		if (!results) {
			// No results (e.g., INSERT/UPDATE/DELETE)
			return { rows: [] };
		}

		// After the check above, `results` is defined and `results.rows` is a
		// required (never-undefined) field per `d1_http_result_schema`.
		const all_rows = results.rows;

		// For "get" method, drizzle expects a single row (not an array of rows)
		if (method === "get") {
			if (all_rows.length === 0) {
				// Return empty array for get() with no results
				return { rows: [] };
			}
			// Return the first row wrapped in an array
			const first_row = all_rows[0];
			if (!first_row) return { rows: [] };
			return { rows: [first_row] };
		}

		// For "all", "values", "run" methods, return rows as-is
		return { rows: all_rows };
	}

	return drizzle(proxy_callback);
}
