/**
 * Remote-backend-specific behaviour not already covered by the generic
 * contract suite (tests/integration/backend-contract.test.ts): HTTP-layer
 * failure paths (unauthorized, SQL errors) mapping to `storage_error`, an
 * observations round-trip over the D1 HTTP driver, and `list_stores`
 * yielding distinct ids end-to-end through the real remote backend.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { create_remote_backend } from "../../backend/remote.js";
import { create_corpus, define_store, json_codec } from "../../index.js";
import { define_observation_type } from "../../observations/index.js";
import { corpus_observations } from "../../observations/schema.js";
import { corpus_snapshots } from "../../schema.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";

const make_meta = (store_id: string, version: string) => ({
	store_id,
	version,
	parents: [],
	created_at: new Date(),
	content_hash: `hash_${version}`,
	content_type: "application/json",
	size_bytes: 0,
	data_key: `${store_id}/hash_${version}`,
});

describe("RemoteBackend — HTTP-layer specifics", () => {
	let d1: FakeD1HttpServer;
	let s3: FakeS3Server;

	beforeEach(() => {
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3 = create_fake_s3();
	});

	afterEach(() => {
		d1.stop();
		s3.stop();
	});

	const make_backend = () =>
		create_remote_backend({
			account_id: "test-account",
			database_id: "test-database",
			api_token: "test-token",
			d1_base_url: d1.url,
			r2: {
				bucket: "test-bucket",
				access_key_id: "test-access-key-id",
				secret_access_key: "test-secret-access-key",
				endpoint: s3.url,
			},
		});

	it("rejects an unauthorized D1 HTTP response as storage_error", async () => {
		// A dedicated always-401 server stands in for Cloudflare rejecting a bad
		// or expired API token — the driver always sends *some* Authorization
		// header, so this exercises the non-2xx handling path, not a literally
		// missing header (that's covered directly in tests/integration/http-fakes.test.ts).
		const unauthorized_server = Bun.serve({
			port: 0,
			fetch: () => new Response("Unauthorized", { status: 401 }),
		});

		try {
			const backend = create_remote_backend({
				account_id: "test-account",
				database_id: "test-database",
				api_token: "bad-token",
				d1_base_url: `http://localhost:${String(unauthorized_server.port)}`,
				r2: {
					bucket: "test-bucket",
					access_key_id: "test-access-key-id",
					secret_access_key: "test-secret-access-key",
					endpoint: s3.url,
				},
			});

			const result = await backend.metadata.get("s1", "v1");

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("storage_error");
			if (result.error.kind !== "storage_error") return;
			expect(result.error.operation).toBe("metadata.get");
		} finally {
			await unauthorized_server.stop();
		}
	});

	it("maps a D1 SQL error envelope to storage_error with the operation name", async () => {
		// Point the driver at a fake D1 that was only given the observations
		// table — any query against corpus_snapshots hits a real "no such table"
		// SQLite error, which the fake surfaces as the documented HTTP-200 +
		// success:false envelope (matching real D1 behaviour for SQL errors).
		const broken_d1 = create_fake_d1_http([corpus_observations]);
		try {
			const backend = create_remote_backend({
				account_id: "test-account",
				database_id: "test-database",
				api_token: "test-token",
				d1_base_url: broken_d1.url,
				r2: {
					bucket: "test-bucket",
					access_key_id: "test-access-key-id",
					secret_access_key: "test-secret-access-key",
					endpoint: s3.url,
				},
			});

			const result = await backend.metadata.put(make_meta("s1", "v1"));

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("storage_error");
			if (result.error.kind !== "storage_error") return;
			expect(result.error.operation).toBe("metadata.put");
		} finally {
			broken_d1.stop();
		}
	});

	it("round-trips an observation over the D1 HTTP driver", async () => {
		const backend = make_backend();
		if (!backend.observations) throw new Error("expected observations client to be wired");

		await backend.metadata.put(make_meta("items", "v1"));

		const sentiment_type = define_observation_type("sentiment", z.object({ subject: z.string(), score: z.number() }));

		const put_result = await backend.observations.put(sentiment_type, {
			source: { store_id: "items", version: "v1" },
			content: { subject: "widget", score: 0.9 },
		});

		expect(put_result.ok).toBe(true);
		if (!put_result.ok) return;

		const get_result = await backend.observations.get(put_result.value.id);
		expect(get_result.ok).toBe(true);
		if (!get_result.ok) return;
		expect(get_result.value.type).toBe("sentiment");
		expect(get_result.value.content).toEqual({ subject: "widget", score: 0.9 });
		expect(get_result.value.source).toEqual({ store_id: "items", version: "v1" });
	});

	it("corpus.transaction() takes the sequential fallback path (no apply_batch)", async () => {
		// RemoteBackend ships without apply_batch (see backend/remote.ts docstring),
		// so every case in the contract suite's "transaction contract" describe
		// block self-skips for this backend (all gated on `if (!backend.apply_batch) return`).
		// This test is what actually exercises corpus.transaction()'s sequential
		// fallback (corpus.ts's sequential_apply_with_compensation) end-to-end
		// over the HTTP driver, per the plan's adversary checklist for this task.
		const backend = make_backend();
		expect(backend.apply_batch).toBeUndefined();

		const item_schema = z.object({ id: z.string() });
		const corpus = create_corpus()
			.with_backend(backend)
			.with_store(define_store("items", json_codec(item_schema)))
			.build();

		const result = await corpus.transaction(async (tx) => {
			const put = await tx.put(corpus.stores.items, { id: "a" });
			if (!put.ok) return put;
			return put;
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.commits).toHaveLength(1);

		const got = await corpus.stores.items.get(result.value.value.version);
		expect(got.ok).toBe(true);
		if (got.ok) expect(got.value.data.id).toBe("a");
	});

	it("list_stores yields distinct store ids over HTTP", async () => {
		const backend = make_backend();

		await backend.metadata.put(make_meta("store-a", "v1"));
		await backend.metadata.put(make_meta("store-a", "v2"));
		await backend.metadata.put(make_meta("store-b", "v1"));

		if (!backend.metadata.list_stores) throw new Error("expected list_stores to be implemented");

		const ids: string[] = [];
		for await (const store_id of backend.metadata.list_stores()) {
			ids.push(store_id);
		}

		expect(ids.toSorted()).toEqual(["store-a", "store-b"]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
