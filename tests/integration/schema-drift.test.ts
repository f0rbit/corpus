/**
 * A drizzle backend reading a table that lacks a schema column (a pre-0.9 D1 without `entity_key`) must fail
 * every op with an actionable storage_error. Unqualified select lists used to hit SQLite's double-quoted-string
 * fallback and read the column NAME back as every row's value (`entity_key: "entity_key"`).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_remote_backend } from "../../backend/remote.js";
import { corpus_observations, define_observation_type } from "../../observations/index.js";
import { corpus_snapshots } from "../../schema.js";
import type { Backend, CorpusError, CorpusEvent, Result, SnapshotMeta } from "../../types.js";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";

type Table = "corpus_snapshots" | "corpus_observations";

const drift_message = (table: Table) =>
	`${table} is missing column "entity_key" — run your drizzle-kit migration for the installed @f0rbit/corpus schema before deploying (see the Cloudflare guide's upgrade section)`;

const entity_indexes: Record<Table, string> = {
	corpus_snapshots: "idx_store_entity",
	corpus_observations: "idx_obs_type_entity",
};

// reproduces a table created before 0.9 — same rows, no entity_key column
const drop_entity_key = (sqlite: Database, table: Table) => {
	sqlite.run(`DROP INDEX ${entity_indexes[table]}`);
	sqlite.run(`ALTER TABLE ${table} DROP COLUMN entity_key`);
};

const seed = (sqlite: Database) => {
	sqlite.run(
		`INSERT INTO corpus_snapshots (store_id, version, parents, created_at, content_hash, content_type, size_bytes, data_key)
		 VALUES ('s', 'v1', '[]', '2026-05-18T09:39:00.019Z', 'h', 'text/plain', 1, 's/h')`,
	);
	sqlite.run(
		`INSERT INTO corpus_observations (id, type, source_store_id, source_version, content, created_at)
		 VALUES ('obs_seed', 'note', 's', 'v1', '{"text":"x"}', '2026-05-18T09:39:00.019Z')`,
	);
};

const meta = (version: string, entity_key?: string): SnapshotMeta => ({
	store_id: "s",
	version,
	parents: [],
	created_at: new Date("2026-06-01T00:00:00.000Z"),
	content_hash: `h_${version}`,
	content_type: "text/plain",
	size_bytes: 1,
	data_key: `s/h_${version}`,
	...(entity_key !== undefined && { entity_key }),
});

const note = define_observation_type("note", z.object({ text: z.string() }));

const expect_drift = (result: Result<unknown, CorpusError>, table: Table, operation: string) => {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error.kind).toBe("storage_error");
	if (result.error.kind !== "storage_error") return;
	expect(result.error.operation).toBe(operation);
	expect(result.error.cause.message).toBe(drift_message(table));
};

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
};

type Harness = { sqlite: () => Database; backend: () => Backend; events: CorpusEvent[] };

const expect_listing_drift = async <T>(h: Harness, iter: AsyncIterable<T>, table: Table, operation: string) => {
	expect(await collect(iter)).toEqual([]);
	const errors = h.events.flatMap((e) => (e.type === "error" ? [e.error] : []));
	expect(errors).toHaveLength(1);
	expect_drift({ ok: false, error: errors[0]! }, table, operation);
};

const run_suite = (name: string, setup: () => Harness) => {
	describe(name, () => {
		const h = setup();

		describe("corpus_snapshots without entity_key", () => {
			beforeEach(() => {
				seed(h.sqlite());
				drop_entity_key(h.sqlite(), "corpus_snapshots");
			});

			it("get fails instead of reading the column name back as the value", async () => {
				expect_drift(await h.backend().metadata.get("s", "v1"), "corpus_snapshots", "metadata.get");
			});

			it("get_latest fails, store-wide and entity-scoped", async () => {
				const backend = h.backend();
				expect_drift(await backend.metadata.get_latest("s"), "corpus_snapshots", "metadata.get_latest");
				expect_drift(
					await backend.metadata.get_latest("s", { entity_key: "e" }),
					"corpus_snapshots",
					"metadata.get_latest",
				);
			});

			it("put fails", async () => {
				expect_drift(await h.backend().metadata.put(meta("v2")), "corpus_snapshots", "metadata.put");
			});

			it("delete fails", async () => {
				expect_drift(await h.backend().metadata.delete("s", "v1"), "corpus_snapshots", "metadata.delete");
				expect(h.sqlite().query("SELECT count(*) AS n FROM corpus_snapshots").get()).toEqual({ n: 1 });
			});

			it("list yields nothing and emits the drift error", async () => {
				await expect_listing_drift(h, h.backend().metadata.list("s"), "corpus_snapshots", "metadata.list");
			});

			it("list with an entity filter emits the drift error", async () => {
				await expect_listing_drift(
					h,
					h.backend().metadata.list("s", { entity_key: "e" }),
					"corpus_snapshots",
					"metadata.list",
				);
			});

			it("list_stores yields nothing and emits the drift error", async () => {
				const list_stores = h.backend().metadata.list_stores;
				expect(list_stores).toBeDefined();
				await expect_listing_drift(h, list_stores!(), "corpus_snapshots", "metadata.list_stores");
			});

			it("observations.put fails resolving the source's entity", async () => {
				const result = await h.backend().observations!.put(note, {
					source: { store_id: "s", version: "v1" },
					content: { text: "y" },
				});
				expect_drift(result, "corpus_snapshots", "metadata.get");
			});
		});

		describe("corpus_observations without entity_key", () => {
			beforeEach(() => {
				seed(h.sqlite());
				drop_entity_key(h.sqlite(), "corpus_observations");
			});

			it("put fails", async () => {
				const result = await h.backend().observations!.put(note, {
					source: { store_id: "s", version: "v1" },
					content: { text: "y" },
				});
				expect_drift(result, "corpus_observations", "observations.put");
			});

			it("get fails", async () => {
				expect_drift(await h.backend().observations!.get("obs_seed"), "corpus_observations", "observations.get");
			});

			it("delete fails and leaves the row", async () => {
				expect_drift(await h.backend().observations!.delete("obs_seed"), "corpus_observations", "observations.delete");
				expect(h.sqlite().query("SELECT count(*) AS n FROM corpus_observations").get()).toEqual({ n: 1 });
			});

			it("delete_by_source fails", async () => {
				expect_drift(
					await h.backend().observations!.delete_by_source({ store_id: "s", version: "v1" }),
					"corpus_observations",
					"observations.delete_by_source",
				);
			});

			it("query yields nothing and emits the drift error", async () => {
				await expect_listing_drift(h, h.backend().observations!.query(), "corpus_observations", "observations.query");
			});

			it("snapshot reads are unaffected", async () => {
				const got = await h.backend().metadata.get("s", "v1");
				expect(got.ok).toBe(true);
				if (got.ok) expect(got.value.entity_key).toBeUndefined();
			});
		});

		describe("current schema", () => {
			beforeEach(() => {
				seed(h.sqlite());
			});

			it("reads, filters, writes and deletes as before", async () => {
				const backend = h.backend();
				const seeded = await backend.metadata.get("s", "v1");
				expect(seeded.ok).toBe(true);
				if (seeded.ok) expect("entity_key" in seeded.value).toBe(false);

				expect((await backend.metadata.put(meta("v2", "e"))).ok).toBe(true);
				const keyed = await backend.metadata.get_latest("s", { entity_key: "e" });
				expect(keyed.ok && keyed.value.version).toBe("v2");
				expect((await collect(backend.metadata.list("s", { entity_key: "e" }))).map((m) => m.version)).toEqual(["v2"]);
				expect(await collect(backend.metadata.list_stores!())).toEqual(["s"]);

				const put = await backend.observations!.put(note, {
					source: { store_id: "s", version: "v2" },
					content: { text: "y" },
				});
				expect(put.ok && put.value.entity_key).toBe("e");
				expect((await collect(backend.observations!.query({ entity_key: "e" }))).map((o) => o.type)).toEqual(["note"]);
				expect((await backend.observations!.delete("obs_seed")).ok).toBe(true);
				expect((await backend.metadata.delete("s", "v1")).ok).toBe(true);
				expect(await collect(backend.metadata.list("s"))).toHaveLength(1);
				expect(h.events.filter((e) => e.type === "error")).toEqual([]);
			});
		});
	});
};

run_suite("CloudflareBackend", () => {
	let d1 = create_fake_d1([corpus_snapshots, corpus_observations]);
	const events: CorpusEvent[] = [];
	beforeEach(() => {
		d1.sqlite.close();
		d1 = create_fake_d1([corpus_snapshots, corpus_observations]);
		events.length = 0;
	});
	return {
		sqlite: () => d1.sqlite,
		backend: () => create_cloudflare_backend({ d1, r2: create_fake_r2(), on_event: (e) => events.push(e) }),
		events,
	};
});

run_suite("RemoteBackend", () => {
	let d1: FakeD1HttpServer;
	let s3: FakeS3Server;
	const events: CorpusEvent[] = [];
	beforeAll(() => {
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3 = create_fake_s3();
	});
	afterAll(() => {
		d1.stop();
		s3.stop();
	});
	beforeEach(() => {
		d1.reset();
		s3.reset();
		events.length = 0;
	});
	return {
		sqlite: () => d1.sqlite,
		backend: () =>
			create_remote_backend({
				account_id: "acct",
				database_id: "db",
				api_token: "tok",
				d1_base_url: d1.url,
				r2: { bucket: "b", access_key_id: "ak", secret_access_key: "sk", endpoint: s3.url },
				on_event: (e) => events.push(e),
			}),
		events,
	};
});

describe("CloudflareBackend apply_batch", () => {
	it("aborts a transaction against a drifted table with the drift message", async () => {
		const d1 = create_fake_d1([corpus_snapshots, corpus_observations]);
		drop_entity_key(d1.sqlite, "corpus_snapshots");
		const backend = create_cloudflare_backend({ d1, r2: create_fake_r2() });
		const result = await backend.apply_batch!([{ type: "meta_put", meta: meta("v2") }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");
		if (result.error.kind !== "transaction_aborted") return;
		expect(result.error.cause?.message).toBe(drift_message("corpus_snapshots"));
		d1.sqlite.close();
	});
});

// live D1 answers a missing column with HTTP 400 + its error envelope, not the 200 + success:false the fake emits
describe("RemoteBackend against a D1 HTTP 400", () => {
	let d1: FakeD1HttpServer;
	let s3: FakeS3Server;
	beforeAll(() => {
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3 = create_fake_s3();
	});
	afterAll(() => {
		d1.stop();
		s3.stop();
	});

	it("maps the envelope's missing-column text to the migration message", async () => {
		d1.set_responder(() =>
			Response.json(
				{
					result: [],
					success: false,
					errors: [{ code: 7500, message: "no such column: corpus_snapshots.entity_key: SQLITE_ERROR" }],
					messages: [],
				},
				{ status: 400 },
			),
		);
		const backend = create_remote_backend({
			account_id: "acct",
			database_id: "db",
			api_token: "tok",
			d1_base_url: d1.url,
			r2: { bucket: "b", access_key_id: "ak", secret_access_key: "sk", endpoint: s3.url },
		});
		expect_drift(await backend.metadata.get("s", "v1"), "corpus_snapshots", "metadata.get");
	});
});
