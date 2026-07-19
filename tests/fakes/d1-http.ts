/**
 * HTTP server fake for Cloudflare D1's `/raw` endpoint, used to test
 * the remote backend without a live Cloudflare account.
 *
 * Serves `POST /accounts/{account}/d1/database/{db}/raw` with body:
 * ```json
 * { "sql": "SELECT ...", "params": [...] }
 * ```
 *
 * Responds with the D1 HTTP envelope:
 * ```json
 * { "success": true, "errors": [], "result": [{ "success": true, "results": { "columns": [...], "rows": [...] } }] }
 * ```
 *
 * SQL errors return HTTP 200 with `success: false`, matching actual CF behaviour.
 */

import type { Database } from "bun:sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { create_fake_d1 } from "./cloudflare.js";

const d1_raw_request_schema = z.object({
	sql: z.string(),
	params: z.array(z.unknown()).optional(),
});

export type D1RawResponse = {
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	result?: Array<{
		success: boolean;
		results?: {
			columns?: string[];
			rows: unknown[][];
		};
	}>;
};

export type FakeD1HttpServer = {
	url: string;
	stop: () => void;
	sqlite: Database;
};

export function create_fake_d1_http(tables: SQLiteTable[]): FakeD1HttpServer {
	const fake_d1 = create_fake_d1(tables);

	const server = Bun.serve({
		port: 0,
		fetch: async (request: Request) => {
			const url = new URL(request.url);
			const path = url.pathname;

			// Match the pattern /accounts/{account}/d1/database/{db}/raw
			const raw_match = /^\/accounts\/[^/]+\/d1\/database\/[^/]+\/raw$/.test(path);
			if (!raw_match) {
				return new Response("Not Found", { status: 404 });
			}

			if (request.method !== "POST") {
				return new Response("Method Not Allowed", { status: 405 });
			}

			// Check for Bearer token in Authorization header
			const auth_header = request.headers.get("Authorization");
			if (!auth_header || !auth_header.startsWith("Bearer ")) {
				return new Response("Unauthorized", { status: 401 });
			}

			try {
				const raw_body: unknown = await request.json();
				const parsed_body = d1_raw_request_schema.safeParse(raw_body);

				if (!parsed_body.success) {
					const response: D1RawResponse = {
						success: false,
						errors: [{ code: 7500, message: "Invalid SQL in request body" }],
						result: [],
					};
					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}

				const { sql, params = [] } = parsed_body.data;

				try {
					const statement = fake_d1.prepare(sql) as {
						bind: (...args: unknown[]) => { raw: () => Promise<unknown[][] | null> };
					};
					const bound = statement.bind(...params);
					// bun:sqlite's Statement.values() returns null (not []) for statements
					// with no result rows (INSERT/UPDATE/DELETE) — normalize to match D1's
					// actual /raw response shape, which always carries an array.
					const rows = (await bound.raw()) ?? [];
					// Column names are optional in the D1 response; default to empty array
					const columns: string[] = [];

					const response: D1RawResponse = {
						success: true,
						errors: [],
						result: [
							{
								success: true,
								results: {
									columns,
									rows,
								},
							},
						],
					};
					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				} catch (sql_error) {
					const message = sql_error instanceof Error ? sql_error.message : String(sql_error);
					const response: D1RawResponse = {
						success: false,
						errors: [{ code: 7500, message }],
						result: [],
					};
					return new Response(JSON.stringify(response), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
			} catch {
				// Invalid JSON in request body
				const response: D1RawResponse = {
					success: false,
					errors: [{ code: 7500, message: "Failed to parse request body as JSON" }],
					result: [],
				};
				return new Response(JSON.stringify(response), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		},
	});

	const port = server.port ?? 0;
	const url = `http://localhost:${String(port)}`;

	return {
		url,
		stop: () => {
			void server.stop();
		},
		sqlite: fake_d1.sqlite,
	};
}
