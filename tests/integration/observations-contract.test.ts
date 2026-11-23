import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { z } from "zod";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_file_backend } from "../../backend/file.js";
import { create_layered_backend } from "../../backend/layered.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_remote_backend } from "../../backend/remote.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations, create_pointer, define_observation_type } from "../../observations/index.js";
import { filter_observation_rows } from "../../observations/storage.js";
import type { ObservationRow } from "../../observations/schema.js";
import type { Backend, CorpusEvent, EventHandler, ObservationsClient, SnapshotMeta } from "../../types";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";

export type ObservationsBackendFactory = (on_event?: EventHandler) => Backend | Promise<Backend>;
export type ObservationsCleanupFn = () => void | Promise<void>;

const sentiment_type = define_observation_type(
	"sentiment",
	z.object({
		subject: z.string(),
		score: z.number().min(-1).max(1),
		keywords: z.array(z.string()),
	}),
);

const entity_type = define_observation_type(
	"entity",
	z.object({
		name: z.string(),
		type: z.enum(["person", "org", "location"]),
		mentions: z.number(),
	}),
);

const simple_type = define_observation_type("simple", z.object({ value: z.string() }));
const price_type = define_observation_type("price", z.object({ amount: z.number() }));

const obs_of = (backend: Backend): ObservationsClient => {
	if (!backend.observations) throw new Error("backend has no observations client");
	return backend.observations;
};

type QueryOpts = NonNullable<Parameters<ObservationsClient["query"]>[0]>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const values = async (observations: ObservationsClient, opts: QueryOpts): Promise<string[]> => {
	const found: string[] = [];
	for await (const obs of observations.query(opts)) found.push((obs.content as { value: string }).value);
	return found;
};

const amounts = async (observations: ObservationsClient, opts: QueryOpts): Promise<number[]> => {
	const found: number[] = [];
	for await (const obs of observations.query(opts)) found.push((obs.content as { amount: number }).amount);
	return found;
};

const source_versions = async (observations: ObservationsClient, opts: QueryOpts): Promise<string[]> => {
	const found: string[] = [];
	for await (const obs of observations.query(opts)) found.push(obs.source.version);
	return found;
};

const meta_versions = async (observations: ObservationsClient, opts: QueryOpts): Promise<string[]> => {
	const found: string[] = [];
	for await (const meta of observations.query_meta(opts)) found.push(meta.source.version);
	return found;
};

const put_simple = (observations: ObservationsClient, store_id: string, version: string, value: string) =>
	observations.put(simple_type, { source: { store_id, version }, content: { value } });

const source = (version: string) => ({ store_id: "pages", version });

let clock = Date.parse("2024-01-01T00:00:00.000Z");

const put_snapshot = async (backend: Backend, version: string, entity_key?: string): Promise<void> => {
	clock += 1000;
	const meta: SnapshotMeta = {
		store_id: "pages",
		version,
		parents: [],
		created_at: new Date(clock),
		content_hash: `hash_${version}`,
		content_type: "application/json",
		size_bytes: 0,
		data_key: `pages/hash_${version}`,
		...(entity_key === undefined ? {} : { entity_key }),
	};
	const result = await backend.metadata.put(meta);
	expect(result.ok).toBe(true);
};

const versions = Array.from({ length: 10 }, (_, i) => `v${String(i)}`);
const oldest_three = ["v0", "v1", "v2"];

const seed_versions = async (observations: ObservationsClient): Promise<void> => {
	for (const [i, version] of versions.entries()) {
		const put = await observations.put(price_type, { source: source(version), content: { amount: i } });
		expect(put.ok).toBe(true);
	}
};

const invalid_contents: [string, unknown][] = [
	["missing field", { subject: "test" }],
	["wrong type", { subject: 123, score: "bad", keywords: "not-array" }],
	["out of range", { subject: "test", score: 5.0, keywords: [] }],
	["score below minimum", { subject: "test", score: -2.0, keywords: [] }],
];

export function run_observations_contract_tests(
	name: string,
	create_backend: ObservationsBackendFactory,
	cleanup?: ObservationsCleanupFn,
) {
	describe(`${name} - Observations Contract`, () => {
		let backend: Backend;
		let observations: ObservationsClient;

		beforeEach(async () => {
			backend = await create_backend();
			observations = obs_of(backend);
		});

		if (cleanup) afterAll(cleanup);

		describe("CRUD edges", () => {
			it("get of a missing id is observation_not_found", async () => {
				const result = await observations.get("nonexistent");
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.kind).toBe("observation_not_found");
			});

			it("delete of a missing id is observation_not_found", async () => {
				const result = await observations.delete("nonexistent");
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.kind).toBe("observation_not_found");
			});
		});

		describe("type validation", () => {
			it.each(invalid_contents)("rejects invalid content - %s", async (_label, content) => {
				const result = await observations.put(sentiment_type, {
					source: create_pointer("docs", "v1"),
					content: content as never,
				});
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.kind).toBe("validation_error");
				expect(await Array.fromAsync(observations.query({}))).toHaveLength(0);
			});

			it("rejects an invalid enum value", async () => {
				const result = await observations.put(entity_type, {
					source: create_pointer("docs", "v1"),
					content: { name: "Test", type: "invalid" as never, mentions: 1 },
				});
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.kind).toBe("validation_error");
			});

			it("accepts a valid enum value", async () => {
				const result = await observations.put(entity_type, {
					source: create_pointer("docs", "v1"),
					content: { name: "Test Corp", type: "org", mentions: 5 },
				});
				expect(result.ok).toBe(true);
			});
		});

		describe("optional fields", () => {
			const round_trip = async (opts: {
				source?: ReturnType<typeof create_pointer>;
				confidence?: number;
				observed_at?: Date;
				derived_from?: ReturnType<typeof create_pointer>[];
			}) => {
				const put = await observations.put(simple_type, {
					source: opts.source ?? create_pointer("docs", "v1"),
					content: { value: "test" },
					...(opts.confidence === undefined ? {} : { confidence: opts.confidence }),
					...(opts.observed_at === undefined ? {} : { observed_at: opts.observed_at }),
					...(opts.derived_from === undefined ? {} : { derived_from: opts.derived_from }),
				});
				expect(put.ok).toBe(true);
				if (!put.ok) throw new Error("put failed");
				const got = await observations.get(put.value.id);
				expect(got.ok).toBe(true);
				if (!got.ok) throw new Error("get failed");
				return got.value;
			};

			it("stores and retrieves confidence", async () => {
				expect((await round_trip({ confidence: 0.95 })).confidence).toBe(0.95);
			});

			it("stores and retrieves observed_at", async () => {
				const observed_at = new Date("2024-06-15T10:30:00Z");
				expect((await round_trip({ observed_at })).observed_at?.toISOString()).toBe(observed_at.toISOString());
			});

			it("stores and retrieves derived_from", async () => {
				const derived_from = [create_pointer("models", "gpt4"), create_pointer("prompts", "sentiment-v2")];
				expect((await round_trip({ derived_from })).derived_from).toEqual(derived_from);
			});

			it("stores source with path", async () => {
				const got = await round_trip({ source: create_pointer("docs", "v1", "$.paragraphs[0]") });
				expect(got.source.path).toBe("$.paragraphs[0]");
			});

			it("stores source with span", async () => {
				const got = await round_trip({ source: create_pointer("docs", "v1", undefined, { start: 100, end: 200 }) });
				expect(got.source.span).toEqual({ start: 100, end: 200 });
			});

			it("stores source with path and span together", async () => {
				const got = await round_trip({
					source: create_pointer("docs", "v1", "$.text", { start: 50, end: 150 }),
				});
				expect(got.source.path).toBe("$.text");
				expect(got.source.span).toEqual({ start: 50, end: 150 });
			});

			it("omits undefined optional fields", async () => {
				const got = await round_trip({});
				expect(got.confidence).toBeUndefined();
				expect(got.observed_at).toBeUndefined();
				expect(got.derived_from).toBeUndefined();
				expect(got.source.path).toBeUndefined();
				expect(got.source.span).toBeUndefined();
				expect("entity_key" in got).toBe(false);
			});
		});

		describe("timestamps", () => {
			it("sets created_at automatically", async () => {
				const before = new Date();
				const result = await put_simple(observations, "docs", "v1", "test");
				const after = new Date();

				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.value.created_at).toBeInstanceOf(Date);
				expect(result.value.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
				expect(result.value.created_at.getTime()).toBeLessThanOrEqual(after.getTime());
			});

			it("preserves created_at on retrieval", async () => {
				const result = await put_simple(observations, "docs", "v1", "test");
				expect(result.ok).toBe(true);
				if (!result.ok) return;

				const got = await observations.get(result.value.id);
				expect(got.ok && got.value.created_at.toISOString()).toBe(result.value.created_at.toISOString());
			});

			it("created_at differs from observed_at", async () => {
				const observed_at = new Date("2024-01-01");
				const result = await observations.put(simple_type, {
					source: create_pointer("docs", "v1"),
					content: { value: "test" },
					observed_at,
				});
				expect(result.ok).toBe(true);
				if (!result.ok) return;

				expect(result.value.created_at.getTime()).not.toBe(observed_at.getTime());
				expect(result.value.observed_at?.toISOString()).toBe(observed_at.toISOString());
			});

			it("filters by created_after and created_before around wall-clock bounds", async () => {
				await put_simple(observations, "docs", "v1", "old");
				await sleep(10);
				const cutoff = new Date();
				await sleep(10);
				await put_simple(observations, "docs", "v2", "new");

				expect(await values(observations, {})).toEqual(["new", "old"]);
				expect(await values(observations, { created_after: cutoff })).toEqual(["new"]);
				expect(await values(observations, { created_before: cutoff })).toEqual(["old"]);
			});
		});

		describe("ids", () => {
			it("generates unique ids with the obs_ prefix", async () => {
				const ids = new Set<string>();
				for (let i = 0; i < 10; i++) {
					const result = await put_simple(observations, "docs", `v${String(i)}`, `test${String(i)}`);
					expect(result.ok).toBe(true);
					if (!result.ok) continue;
					expect(result.value.id.startsWith("obs_")).toBe(true);
					ids.add(result.value.id);
				}
				expect(ids.size).toBe(10);
			});
		});

		describe("query keys", () => {
			it("rejects unknown query keys: yields nothing and emits one validation_error", async () => {
				const events: CorpusEvent[] = [];
				const watched = obs_of(await create_backend((e) => events.push(e)));
				await put_simple(watched, "docs", "v1", "x");
				events.length = 0;

				const bad = { type: "simple", content: { value: "x" } };
				const rows: unknown[] = [];
				// @ts-expect-error `content` is not a query key
				for await (const obs of watched.query(bad)) rows.push(obs);

				expect(rows.length).toBe(0);
				const errors = events.filter((e) => e.type === "error");
				expect(errors.length).toBe(1);
				const [first] = errors;
				expect(first?.type === "error" && first.error.kind).toBe("validation_error");
			});
		});

		describe("content retrieval", () => {
			it("preserves complex nested content", async () => {
				const complex_type = define_observation_type(
					"complex",
					z.object({
						nested: z.object({
							array: z.array(z.object({ key: z.string(), values: z.array(z.number()) })),
							optional: z.string().optional(),
						}),
					}),
				);
				const content = {
					nested: {
						array: [
							{ key: "a", values: [1, 2, 3] },
							{ key: "b", values: [4, 5] },
						],
						optional: "present",
					},
				};

				const result = await observations.put(complex_type, { source: create_pointer("docs", "v1"), content });
				expect(result.ok).toBe(true);
				if (!result.ok) return;

				const got = await observations.get(result.value.id);
				expect(got.ok && got.value.content).toEqual(content);
			});

			it("handles special characters in content", async () => {
				const content = { value: 'test with "quotes" and \\backslash and unicode: 日本語' };
				const result = await observations.put(simple_type, { source: create_pointer("docs", "v1"), content });
				expect(result.ok).toBe(true);
				if (!result.ok) return;

				const got = await observations.get(result.value.id);
				expect(got.ok && got.value.content).toEqual(content);
			});
		});

		describe("entity_key", () => {
			it("inherits entity_key from the source snapshot", async () => {
				await put_snapshot(backend, "a1", "A");
				const put = await observations.put(price_type, { source: source("a1"), content: { amount: 1 } });

				expect(put.ok && put.value.entity_key).toBe("A");
				const got = await observations.get(put.ok ? put.value.id : "");
				expect(got.ok && got.value.entity_key).toBe("A");
			});

			it("explicit entity_key overrides the source snapshot's", async () => {
				await put_snapshot(backend, "a1", "A");
				const put = await observations.put(price_type, {
					source: source("a1"),
					content: { amount: 1 },
					entity_key: "Z",
				});

				expect(put.ok && put.value.entity_key).toBe("Z");
				expect(await amounts(observations, { entity_key: "Z" })).toEqual([1]);
				expect(await amounts(observations, { entity_key: "A" })).toEqual([]);
			});

			it("stores no key when the source is unkeyed, and omits it on round-trip", async () => {
				await put_snapshot(backend, "u1");
				const put = await observations.put(price_type, { source: source("u1"), content: { amount: 1 } });

				expect(put.ok && "entity_key" in put.value).toBe(false);
				const got = await observations.get(put.ok ? put.value.id : "");
				expect(got.ok && "entity_key" in got.value).toBe(false);
				expect(await amounts(observations, {})).toEqual([1]);
				expect(await amounts(observations, { entity_key: "A" })).toEqual([]);
			});

			it("put succeeds without a key when the source snapshot is missing", async () => {
				const put = await observations.put(price_type, { source: source("ghost"), content: { amount: 1 } });

				expect(put.ok).toBe(true);
				expect(put.ok && "entity_key" in put.value).toBe(false);
			});

			it("query filters by entity_key before limit with interleaved entities", async () => {
				await put_snapshot(backend, "a1", "A");
				await put_snapshot(backend, "b1", "B");
				await observations.put(price_type, { source: source("a1"), content: { amount: 1 } });
				await sleep(5);
				await observations.put(price_type, { source: source("b1"), content: { amount: 2 } });
				await sleep(5);
				await observations.put(price_type, { source: source("b1"), content: { amount: 3 } });

				expect(await amounts(observations, { entity_key: "A", limit: 1 })).toEqual([1]);
				expect(await amounts(observations, { entity_key: "B", limit: 1 })).toEqual([3]);
				expect(await amounts(observations, { type: "price", entity_key: "B" })).toEqual([3, 2]);
			});

			it("query_meta carries entity_key", async () => {
				await put_snapshot(backend, "a1", "A");
				await observations.put(price_type, { source: source("a1"), content: { amount: 1 } });

				const keys: (string | undefined)[] = [];
				for await (const meta of observations.query_meta({ entity_key: "A" })) keys.push(meta.entity_key);
				expect(keys).toEqual(["A"]);
			});

			describe("is_stale", () => {
				it("a new snapshot of another entity does not stale a keyed pointer (#57 item 4)", async () => {
					await put_snapshot(backend, "a1", "A");
					await put_snapshot(backend, "b1", "B");

					expect(await observations.is_stale(source("a1"))).toBe(false);
				});

				it("a newer snapshot of the same entity stales the pointer", async () => {
					await put_snapshot(backend, "a1", "A");
					await put_snapshot(backend, "b1", "B");
					await put_snapshot(backend, "a2", "A");

					expect(await observations.is_stale(source("a1"))).toBe(true);
					expect(await observations.is_stale(source("a2"))).toBe(false);
				});

				it("unkeyed pointers use the store-wide rule", async () => {
					await put_snapshot(backend, "u1");
					await put_snapshot(backend, "u2");

					expect(await observations.is_stale(source("u1"))).toBe(true);
					expect(await observations.is_stale(source("u2"))).toBe(false);
				});

				it("a missing source falls back to the store-wide rule", async () => {
					expect(await observations.is_stale(source("ghost"))).toBe(false);

					await put_snapshot(backend, "a1", "A");
					expect(await observations.is_stale(source("ghost"))).toBe(true);
				});
			});
		});

		describe("version_filter with limit", () => {
			beforeEach(async () => {
				await seed_versions(observations);
			});

			it("Set filter applies before limit", async () => {
				const opts = { version_filter: new Set(oldest_three), limit: 2 };
				expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
				expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
			});

			it("array filter applies before limit", async () => {
				const opts = { version_filter: oldest_three, limit: 2 };
				expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
				expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
			});

			it("function filter applies before limit", async () => {
				const opts = {
					version_filter: (_store_id: string, version: string) => oldest_three.includes(version),
					limit: 2,
				};
				expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
				expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
			});

			it("empty Set and array yield nothing", async () => {
				expect(await source_versions(observations, { version_filter: new Set<string>(), limit: 2 })).toEqual([]);
				expect(await source_versions(observations, { version_filter: [] })).toEqual([]);
				expect(await meta_versions(observations, { version_filter: new Set<string>() })).toEqual([]);
			});

			it("without a limit returns every match", async () => {
				expect((await source_versions(observations, { version_filter: new Set(oldest_three) })).toSorted()).toEqual(
					oldest_three,
				);
			});
		});

		describe("exclude_source_version", () => {
			it("combines with source_store; limit 1 returns the newest previous observation", async () => {
				await put_simple(observations, "docs", "v1", "old");
				await sleep(5);
				await put_simple(observations, "docs", "v2", "newer");
				await sleep(5);
				await put_simple(observations, "other", "v9", "other-store");
				await sleep(5);
				await put_simple(observations, "docs", "v3", "current");

				const previous = await values(observations, {
					type: "simple",
					source_store: "docs",
					exclude_source_version: "v3",
					limit: 1,
				});
				expect(previous).toEqual(["newer"]);
			});
		});
	});
}

const make_row = (id: string, version: string, created_at: string): ObservationRow => ({
	id,
	type: "simple",
	source_store_id: "docs",
	source_version: version,
	source_path: null,
	source_span_start: null,
	source_span_end: null,
	content: JSON.stringify({ value: id }),
	confidence: null,
	observed_at: null,
	created_at,
	derived_from: null,
	entity_key: null,
});

const tmp_dirs: string[] = [];

const make_file = async (on_event?: EventHandler): Promise<Backend> => {
	const dir = await make_tmp_dir("obs-contract");
	tmp_dirs.push(dir);
	return create_file_backend({ base_path: dir, on_event });
};

const make_cloudflare = (on_event?: EventHandler): Backend =>
	create_cloudflare_backend({
		d1: create_fake_d1([corpus_snapshots, corpus_observations]),
		r2: create_fake_r2(),
		on_event,
	});

let remote_fakes: { d1: FakeD1HttpServer; s3: FakeS3Server } | undefined;

const make_remote = (on_event?: EventHandler): Backend => {
	remote_fakes ??= {
		d1: create_fake_d1_http([corpus_snapshots, corpus_observations]),
		s3: create_fake_s3(),
	};
	const { d1, s3 } = remote_fakes;
	d1.reset();
	s3.reset();
	return create_remote_backend({
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
		on_event,
	});
};

const stop_remote = (): void => {
	remote_fakes?.d1.stop();
	remote_fakes?.s3.stop();
	remote_fakes = undefined;
};

const remove_dirs = async (): Promise<void> => {
	await Promise.all(tmp_dirs.splice(0).map(remove_tmp_dir));
};

run_observations_contract_tests("memory", (on_event) => create_memory_backend({ on_event }));
run_observations_contract_tests("file", make_file, remove_dirs);
run_observations_contract_tests(
	"layered (memory cache over file)",
	async (on_event) => {
		const cache = create_memory_backend({ on_event });
		const disk = await make_file();
		return create_layered_backend({ read: [cache, disk], write: [cache, disk] });
	},
	remove_dirs,
);
run_observations_contract_tests("cloudflare (drizzle)", make_cloudflare);
run_observations_contract_tests("remote (faked D1 HTTP + S3)", make_remote, stop_remote);

describe("file persistence", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await make_tmp_dir("obs-persist");
		tmp_dirs.push(dir);
	});

	afterAll(remove_dirs);

	it("persists observations across backend instances", async () => {
		const observations = obs_of(create_file_backend({ base_path: dir }));
		const result = await put_simple(observations, "docs", "v1", "persistent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const reopened = obs_of(create_file_backend({ base_path: dir }));
		const got = await reopened.get(result.value.id);
		expect(got.ok && got.value.content).toEqual({ value: "persistent" });
	});

	it("persists multiple observations", async () => {
		const observations = obs_of(create_file_backend({ base_path: dir }));
		await put_simple(observations, "docs", "v1", "a");
		await put_simple(observations, "docs", "v2", "b");

		const reopened = obs_of(create_file_backend({ base_path: dir }));
		expect(await Array.fromAsync(reopened.query({}))).toHaveLength(2);
	});
});

describe("same-ms ordering - JS adapters", () => {
	it("returns later-inserted rows first when created_at is identical", () => {
		const at = "2024-01-01T00:00:00.000Z";
		const rows = [make_row("a", "v1", at), make_row("b", "v1", at), make_row("c", "v1", at)];

		expect(filter_observation_rows(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
		expect(filter_observation_rows(rows, { limit: 1 }).map((r) => r.id)).toEqual(["c"]);
	});

	it("still orders by created_at before insertion order", () => {
		const rows = [make_row("a", "v1", "2024-01-02T00:00:00.000Z"), make_row("b", "v1", "2024-01-01T00:00:00.000Z")];

		expect(filter_observation_rows(rows).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("applies exclude_source_version at the storage layer", () => {
		const at = "2024-01-01T00:00:00.000Z";
		const rows = [make_row("a", "v1", at), make_row("b", "v2", at)];

		expect(filter_observation_rows(rows, { exclude_source_version: "v2" }).map((r) => r.id)).toEqual(["a"]);
	});
});

describe("same-ms ordering - drizzle", () => {
	it("returns later-inserted rows first when created_at is identical", async () => {
		const backend = make_cloudflare();
		const at = "2024-01-01T00:00:00.000Z";
		// ids ascend against insertion order so an id-based tie-break would fail
		if (!backend.apply_batch) throw new Error("cloudflare backend must support apply_batch");
		const applied = await backend.apply_batch(
			["z", "y", "x"].map((id) => ({ type: "observation_put", row: make_row(`obs_${id}`, "v1", at) })),
		);
		expect(applied.ok).toBe(true);
		const ids: string[] = [];
		for await (const obs of obs_of(backend).query({})) ids.push(obs.id);
		expect(ids).toEqual(["obs_x", "obs_y", "obs_z"]);
	});
});
