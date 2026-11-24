/**
 * Self-tests for the HTTP server fakes (D1 HTTP + S3).
 *
 * Verifies:
 * - D1 HTTP server responds to queries with correct envelope
 * - D1 HTTP returns 401 when Bearer token missing
 * - D1 HTTP returns error envelope on SQL errors
 * - S3 server handles GET/PUT/HEAD/DELETE correctly
 * - S3 GET/HEAD of missing key returns 404
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { d1_http_response_schema } from "../../backend/remote-d1.js";
import { corpus_observations } from "../../observations/schema.js";
import { corpus_snapshots } from "../../schema.js";
import { create_fake_d1_http } from "../fakes/d1-http.js";
import { create_fake_s3 } from "../fakes/s3.js";

describe("D1 HTTP Server Fake", () => {
	let server: ReturnType<typeof create_fake_d1_http>;

	beforeEach(() => {
		server = create_fake_d1_http([corpus_snapshots, corpus_observations]);
	});

	afterEach(() => {
		server.stop();
	});

	it("responds to valid query with D1 envelope", async () => {
		const response = await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sql: "SELECT COUNT(*) as count FROM corpus_snapshots",
				params: [],
			}),
		});

		expect(response.status).toBe(200);
		const data = d1_http_response_schema.parse(await response.json());
		expect(data.success).toBe(true);
		expect(data.errors).toEqual([]);
		expect(data.result).toBeDefined();
		expect(Array.isArray(data.result)).toBe(true);
		if (data.result[0]) {
			expect(data.result[0].success).toBe(true);
			expect(data.result[0].results?.rows).toBeDefined();
		}
	});

	it("returns 401 when Bearer token is missing", async () => {
		const response = await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sql: "SELECT 1",
				params: [],
			}),
		});

		expect(response.status).toBe(401);
	});

	it("returns error envelope on SQL error with HTTP 200", async () => {
		const response = await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sql: "SELECT * FROM nonexistent_table",
				params: [],
			}),
		});

		expect(response.status).toBe(200);
		const data = d1_http_response_schema.parse(await response.json());
		expect(data.success).toBe(false);
		expect(Array.isArray(data.errors)).toBe(true);
		expect(data.errors.length).toBeGreaterThan(0);
		expect(data.errors[0]?.code).toBe(7500);
	});

	it("returns 404 for invalid path", async () => {
		const response = await fetch(`${server.url}/invalid/path`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sql: "SELECT 1" }),
		});

		expect(response.status).toBe(404);
	});

	it("executes parameterized query", async () => {
		// Insert a row
		await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sql: `INSERT INTO corpus_snapshots
					(store_id, version, parents, created_at, content_hash, content_type, size_bytes, data_key)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				params: ["test-store", "v1", "[]", "2024-01-01T00:00:00Z", "abc123", "application/json", 42, "test-key"],
			}),
		});

		// Query with parameter
		const response = await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				sql: "SELECT * FROM corpus_snapshots WHERE store_id = ?",
				params: ["test-store"],
			}),
		});

		expect(response.status).toBe(200);
		const data = d1_http_response_schema.parse(await response.json());
		expect(data.success).toBe(true);
		expect(data.result[0]?.results?.rows.length ?? 0).toBeGreaterThan(0);
	});

	it("set_responder: a returned Response wins, undefined falls through to normal behaviour, reset() clears it", async () => {
		const query = () =>
			fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({ sql: "SELECT COUNT(*) AS n FROM corpus_snapshots", params: [] }),
			});

		server.set_responder(() => new Response("boom", { status: 500 }));
		expect((await query()).status).toBe(500);

		server.set_responder(() => undefined);
		const fallthrough = await query();
		expect(fallthrough.status).toBe(200);
		expect(d1_http_response_schema.parse(await fallthrough.json()).success).toBe(true);

		server.set_responder(() => new Response("boom", { status: 500 }));
		server.reset();
		expect((await query()).status).toBe(200);
	});

	it("reset() drops state, keeps the schema and keeps serving", async () => {
		const query = async (sql: string, params: unknown[] = []) => {
			const response = await fetch(`${server.url}/accounts/test/d1/database/test/raw`, {
				method: "POST",
				headers: {
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ sql, params }),
			});
			return d1_http_response_schema.parse(await response.json());
		};

		const inserted = await query(
			`INSERT INTO corpus_snapshots
				(store_id, version, parents, created_at, content_hash, content_type, size_bytes, data_key)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			["test-store", "v1", "[]", "2024-01-01T00:00:00Z", "abc123", "application/json", 42, "test-key"],
		);
		expect(inserted.success).toBe(true);
		const before = await query("SELECT * FROM corpus_snapshots");
		expect(before.result[0]?.results?.rows.length).toBe(1);

		server.reset();

		const after = await query("SELECT * FROM corpus_snapshots");
		expect(after.success).toBe(true);
		expect(after.result[0]?.results?.rows).toEqual([]);
		const observations = await query("SELECT * FROM corpus_observations");
		expect(observations.success).toBe(true);
		expect(server.sqlite.query("SELECT COUNT(*) AS n FROM corpus_snapshots").get()).toEqual({ n: 0 });
	});
});

describe("S3 Server Fake", () => {
	let server: ReturnType<typeof create_fake_s3>;

	beforeEach(() => {
		server = create_fake_s3();
	});

	afterEach(() => {
		server.stop();
	});

	it("stores and retrieves data with PUT/GET", async () => {
		const key = "test/object.bin";
		const data = new TextEncoder().encode("hello world");

		// PUT
		const put_response = await fetch(`${server.url}/bucket/${key}`, {
			method: "PUT",
			body: data,
		});
		expect(put_response.status).toBe(200);

		// GET
		const get_response = await fetch(`${server.url}/bucket/${key}`, {
			method: "GET",
		});
		expect(get_response.status).toBe(200);
		const retrieved = await get_response.arrayBuffer();
		expect(new Uint8Array(retrieved)).toEqual(data);
	});

	it("returns 404 for GET of missing key", async () => {
		const response = await fetch(`${server.url}/bucket/nonexistent`, {
			method: "GET",
		});
		expect(response.status).toBe(404);
		const text = await response.text();
		expect(text).toContain("NoSuchKey");
	});

	it("returns 404 for HEAD of missing key", async () => {
		const response = await fetch(`${server.url}/bucket/nonexistent`, {
			method: "HEAD",
		});
		expect(response.status).toBe(404);
	});

	it("returns correct content-length on HEAD", async () => {
		const key = "test/object.bin";
		const data = new TextEncoder().encode("hello world");

		// PUT first
		await fetch(`${server.url}/bucket/${key}`, {
			method: "PUT",
			body: data,
		});

		// HEAD
		const response = await fetch(`${server.url}/bucket/${key}`, {
			method: "HEAD",
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Length")).toBe(String(data.length));
	});

	it("deletes objects with DELETE", async () => {
		const key = "test/object.bin";
		const data = new TextEncoder().encode("hello world");

		// PUT
		await fetch(`${server.url}/bucket/${key}`, {
			method: "PUT",
			body: data,
		});

		// DELETE
		const delete_response = await fetch(`${server.url}/bucket/${key}`, {
			method: "DELETE",
		});
		expect(delete_response.status).toBe(204);

		// Verify it's gone
		const get_response = await fetch(`${server.url}/bucket/${key}`, {
			method: "GET",
		});
		expect(get_response.status).toBe(404);
	});

	it("tracks stored objects with has() and keys()", async () => {
		expect(server.has("test")).toBe(false);
		expect(server.keys()).toEqual([]);

		// After storing via HTTP
		await fetch(`${server.url}/bucket/key1`, {
			method: "PUT",
			body: new Uint8Array([1, 2, 3]),
		});

		// Now verify the methods work
		expect(server.has("key1")).toBe(true);
		expect(server.keys()).toContain("key1");
	});

	it("supports virtual-host style URLs", async () => {
		const data = new TextEncoder().encode("hello world");

		// Virtual-host style: {bucket}.{host}/{key}
		const url = new URL(`${server.url}/test/object.bin`);
		url.hostname = `mybucket.${url.hostname}`;

		// PUT with virtual-host style
		const put_response = await fetch(url.toString(), {
			method: "PUT",
			body: data,
		});
		expect(put_response.status).toBe(200);

		// GET with virtual-host style
		const get_response = await fetch(url.toString(), {
			method: "GET",
		});
		expect(get_response.status).toBe(200);
		const retrieved = await get_response.arrayBuffer();
		expect(new Uint8Array(retrieved)).toEqual(data);
	});

	it("reset() clears objects and keeps serving", async () => {
		await fetch(`${server.url}/bucket/test/object.bin`, { method: "PUT", body: new Uint8Array([1, 2, 3]) });
		expect(server.has("test/object.bin")).toBe(true);

		server.reset();

		expect(server.keys()).toEqual([]);
		const missing = await fetch(`${server.url}/bucket/test/object.bin`, { method: "GET" });
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain("NoSuchKey");

		const put_response = await fetch(`${server.url}/bucket/other`, { method: "PUT", body: new Uint8Array([9]) });
		expect(put_response.status).toBe(200);
		expect(server.keys()).toEqual(["other"]);
	});

	it("set_responder: a returned Response wins, undefined falls through to normal behaviour, reset() clears it", async () => {
		await fetch(`${server.url}/bucket/k`, { method: "PUT", body: new Uint8Array([1]) });

		server.set_responder((request) => (request.method === "HEAD" ? new Response("", { status: 500 }) : undefined));
		expect((await fetch(`${server.url}/bucket/k`, { method: "HEAD" })).status).toBe(500);
		expect((await fetch(`${server.url}/bucket/k`, { method: "GET" })).status).toBe(200);

		server.reset();
		server.set_responder(() => new Response("", { status: 500 }));
		server.reset();
		expect((await fetch(`${server.url}/bucket/k`, { method: "HEAD" })).status).toBe(404);
	});

	it("stores bytes exactly without corruption", async () => {
		const key = "test/binary";
		// Create a buffer with all byte values
		const data = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			data[i] = i;
		}

		// PUT
		await fetch(`${server.url}/bucket/${key}`, {
			method: "PUT",
			body: data,
		});

		// GET and verify exact match
		const response = await fetch(`${server.url}/bucket/${key}`, {
			method: "GET",
		});
		const retrieved = await response.arrayBuffer();
		expect(new Uint8Array(retrieved)).toEqual(data);
	});
});
