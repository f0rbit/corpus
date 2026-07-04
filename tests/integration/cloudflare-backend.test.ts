/**
 * Cloudflare-backend-specific behaviour, beyond the shared contract suite:
 * D1 batch atomicity, the R2-before-D1 write ordering in apply_batch,
 * documented orphan semantics, storage_error mapping, and the observations
 * query path through real SQL. Runs the real `backend/cloudflare.ts` against
 * the in-memory platform fakes from tests/fakes/cloudflare.ts.
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { create_cloudflare_backend } from "../../backend/cloudflare";
import { corpus_snapshots } from "../../schema";
import { corpus_observations, define_observation_type } from "../../observations";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare";
import type { BatchOp, CorpusEvent, EventHandler, SnapshotMeta } from "../../types";

type ObservationRow = typeof corpus_observations.$inferSelect;

const make_meta = (store_id: string, version: string, opts?: Partial<SnapshotMeta>): SnapshotMeta => ({
	store_id,
	version,
	parents: [],
	created_at: new Date(),
	content_hash: `hash_${version}`,
	content_type: "application/json",
	size_bytes: 0,
	data_key: `${store_id}/hash_${version}`,
	...opts,
});

const make_obs_row = (id: string, type = "sentiment"): ObservationRow => ({
	id,
	type,
	source_store_id: "items",
	source_version: "v1",
	source_path: null,
	source_span_start: null,
	source_span_end: null,
	content: JSON.stringify({ score: 1 }),
	confidence: null,
	observed_at: null,
	created_at: new Date().toISOString(),
	derived_from: null,
});

const setup = (on_event?: EventHandler) => {
	const d1 = create_fake_d1([corpus_snapshots, corpus_observations]);
	const r2 = create_fake_r2();
	const backend = create_cloudflare_backend(on_event ? { d1, r2, on_event } : { d1, r2 });
	return { d1, r2, backend };
};

describe("CloudflareBackend - metadata.list store_id filtering", () => {
	it("uses exact match, not prefix match (regression: commit 02bee7f)", async () => {
		const { backend } = setup();
		await backend.metadata.put(make_meta("items", "v1"));
		await backend.metadata.put(make_meta("items-archive", "v2"));

		const versions: string[] = [];
		for await (const meta of backend.metadata.list("items")) {
			versions.push(meta.version);
		}

		expect(versions).toEqual(["v1"]);
	});
});

describe("CloudflareBackend - apply_batch atomicity", () => {
	it("rolls back every D1 write when one statement in the batch fails", async () => {
		const { backend } = setup();

		const ops: BatchOp[] = [
			{ type: "meta_put", meta: make_meta("items", "v1") },
			{ type: "observation_put", row: make_obs_row("obs-1") },
			// Duplicate primary key — the D1 batch must reject and roll back.
			{ type: "observation_put", row: make_obs_row("obs-1") },
		];

		const result = await backend.apply_batch!(ops);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");
		if (result.error.kind !== "transaction_aborted") return;
		expect(result.error.reason).toBe("apply_batch_failed");

		const meta = await backend.metadata.get("items", "v1");
		expect(meta.ok).toBe(false);
	});

	it("aborts before any D1 write when an R2 put fails", async () => {
		const { d1, r2 } = setup();
		const failing_r2 = {
			...r2,
			put: async () => {
				throw new Error("r2 unavailable");
			},
		};
		const backend = create_cloudflare_backend({ d1, r2: failing_r2 });

		const ops: BatchOp[] = [
			{ type: "data_put", data_key: "items/hash_v1", bytes: new TextEncoder().encode("payload") },
			{ type: "meta_put", meta: make_meta("items", "v1") },
		];

		const result = await backend.apply_batch!(ops);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");

		const meta = await backend.metadata.get("items", "v1");
		expect(meta.ok).toBe(false);
		if (meta.ok) return;
		expect(meta.error.kind).toBe("not_found");
		expect(r2.has("items/hash_v1")).toBe(false);
	});

	it("leaves already-written R2 objects as orphans when the D1 batch fails (documented)", async () => {
		const { r2, backend } = setup();

		const ops: BatchOp[] = [
			{ type: "data_put", data_key: "items/hash_v1", bytes: new TextEncoder().encode("payload") },
			{ type: "meta_put", meta: make_meta("items", "v1") },
			{ type: "observation_put", row: make_obs_row("obs-1") },
			{ type: "observation_put", row: make_obs_row("obs-1") },
		];

		const result = await backend.apply_batch!(ops);

		expect(result.ok).toBe(false);
		// Metadata is the source of truth: nothing committed to D1...
		const meta = await backend.metadata.get("items", "v1");
		expect(meta.ok).toBe(false);
		// ...but the content-addressed R2 blob remains, awaiting corpus.gc().
		expect(r2.has("items/hash_v1")).toBe(true);
	});

	it("succeeds with an empty batch and with data-only batches", async () => {
		const { r2, backend } = setup();

		const empty = await backend.apply_batch!([]);
		expect(empty.ok).toBe(true);

		const data_only = await backend.apply_batch!([
			{ type: "data_put", data_key: "items/solo", bytes: new TextEncoder().encode("x") },
		]);
		expect(data_only.ok).toBe(true);
		expect(r2.has("items/solo")).toBe(true);
	});
});

describe("CloudflareBackend - error mapping", () => {
	it("maps thrown D1 errors to storage_error with the failing operation", async () => {
		const { d1, backend } = setup();
		d1.sqlite.close();

		const get = await backend.metadata.get("items", "v1");
		expect(get.ok).toBe(false);
		if (get.ok) return;
		expect(get.error.kind).toBe("storage_error");
		if (get.error.kind !== "storage_error") return;
		expect(get.error.operation).toBe("metadata.get");

		const put = await backend.metadata.put(make_meta("items", "v1"));
		expect(put.ok).toBe(false);
		if (put.ok) return;
		expect(put.error.kind).toBe("storage_error");
		if (put.error.kind !== "storage_error") return;
		expect(put.error.operation).toBe("metadata.put");
	});

	it("metadata.list yields nothing and emits an error event when D1 fails", async () => {
		const events: CorpusEvent[] = [];
		const { d1, backend } = setup((event) => {
			events.push(event);
		});
		d1.sqlite.close();

		const versions: string[] = [];
		for await (const meta of backend.metadata.list("items")) {
			versions.push(meta.version);
		}

		expect(versions).toHaveLength(0);
		const error_events = events.filter((e) => e.type === "error");
		expect(error_events).toHaveLength(1);
		const error_event = error_events[0];
		if (error_event?.type !== "error") return;
		expect(error_event.error.kind).toBe("storage_error");
	});
});

describe("CloudflareBackend - observations through real SQL", () => {
	const SentimentType = define_observation_type("sentiment", z.object({ score: z.number() }));
	const TopicType = define_observation_type("topic", z.object({ name: z.string() }));

	it("put + query filters by type and source", async () => {
		const { backend } = setup();
		const observations = backend.observations!;

		const source = { store_id: "items", version: "v1" };
		const a = await observations.put(SentimentType, { source, content: { score: 0.9 } });
		const b = await observations.put(SentimentType, {
			source: { store_id: "items", version: "v2" },
			content: { score: 0.1 },
		});
		const c = await observations.put(TopicType, { source, content: { name: "testing" } });
		expect(a.ok && b.ok && c.ok).toBe(true);

		const by_type: string[] = [];
		for await (const obs of observations.query({ type: "sentiment" })) {
			by_type.push(obs.id);
		}
		expect(by_type).toHaveLength(2);

		const by_source: string[] = [];
		for await (const obs of observations.query({ source_store: "items", source_version: "v1" })) {
			by_source.push(obs.type);
		}
		expect(by_source.sort()).toEqual(["sentiment", "topic"]);
	});

	it("get + delete round-trip", async () => {
		const { backend } = setup();
		const observations = backend.observations!;

		const put = await observations.put(SentimentType, {
			source: { store_id: "items", version: "v1" },
			content: { score: 0.5 },
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const found = await observations.get(put.value.id);
		expect(found.ok).toBe(true);

		const deleted = await observations.delete(put.value.id);
		expect(deleted.ok).toBe(true);

		const gone = await observations.get(put.value.id);
		expect(gone.ok).toBe(false);
		if (gone.ok) return;
		expect(gone.error.kind).toBe("observation_not_found");
	});
});
