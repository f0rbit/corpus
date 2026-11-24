/**
 * Cross-backend model-based equivalence for the observations client.
 *
 * Runs shrinkable command sequences against a hand-rolled reference model (two
 * plain Maps — NOT a backend) and five real backends (memory, file, layered,
 * cloudflare over D1/R2 fakes, remote over the D1-HTTP/S3 fakes), asserting per
 * command that every backend agrees with the model:
 *
 * - `ok` flags agree, and an err's `error.kind` matches
 * - ok values structurally equal (Dates as epoch ms; `id` and `created_at`
 *   differ in nothing but wall clock, so `created_at` is dropped)
 * - `query` / `query_meta` are compared IN ORDER: newest `created_at` first,
 *   ties broken by later insertion first. `created_at` is non-decreasing with
 *   insertion within a run, so the expected order is the reverse insertion
 *   order of the surviving rows.
 *
 * IDS: every put supplies a caller id from a small pool (`ObservationPutOpts.id`).
 * That lets the model and the SUT refer to observations by the same id, and
 * makes a repeated id a first-class command outcome (`validation_error`, never
 * an overwrite). Backend-generated ids are covered by observations-contract.
 *
 * EXCLUDED: `created_after` / `created_before` filters (wall clock; contract
 * covers them) and span/derived_from payloads (contract round-trips them).
 *
 * REMOTE shares one fake D1-HTTP + S3 pair for the whole file (started in
 * beforeAll, stopped in afterAll); `build` resets both BEFORE constructing the
 * fresh backend and never stops them.
 *
 * Payload arbitraries are plain `fc.*` — never testing.compose (its fc.gen()
 * shrinker does not terminate). Dates are clamped to 2000-2100.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { z } from "zod";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";
import { provider_equivalence, equivalence_command } from "../../testing/laws/provider-equivalence.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import { create_layered_backend } from "../../backend/layered.js";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_remote_backend } from "../../backend/remote.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations, define_observation_type } from "../../observations/index.js";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";
import { ok, err } from "../../types.js";
import type { Backend, CorpusError, ObservationsClient, Result, SnapshotMeta } from "../../types.js";

let root = "";
let d1_http: FakeD1HttpServer | undefined;
let s3_fake: FakeS3Server | undefined;

// ---------------------------------------------------------------------------
// Pools — small on purpose so commands interact (gets hit puts, filters match)
// ---------------------------------------------------------------------------

const STORES = ["pages", "docs"] as const;
const VERSIONS = ["v1", "v2", "v3", "v4"] as const;
const PATHS = [undefined, "$.a", "$.b"] as const;
const ENTITIES = [undefined, "e1", "e2"] as const;
const TYPE_NAMES = ["note", "tag"] as const;
const VALUES = ["a", "b", "c"] as const;
const PREFIXES = ["v", "v1", "v2", "x"] as const;
const OBS_IDS = Array.from({ length: 12 }, (_, i) => `obs_o${String(i)}`);
const OBSERVED_AT = ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"].map((d) => new Date(`${d}T00:00:00.000Z`));
const SNAPSHOT_AT = ["2024-03-01", "2024-03-02", "2024-03-03", "2024-03-04"].map((d) => new Date(`${d}T00:00:00.000Z`));

const content_schema = z.object({ value: z.string() });
const type_defs = {
	note: define_observation_type("note", content_schema),
	tag: define_observation_type("tag", content_schema),
};

const maybe = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined, freq: 2 });

const store_arb = fc.constantFrom(...STORES);
const version_arb = fc.constantFrom(...VERSIONS);
const path_arb = fc.constantFrom(...PATHS);
const entity_arb = fc.constantFrom(...ENTITIES);
const type_arb = fc.constantFrom(...TYPE_NAMES);
const id_arb = fc.constantFrom(...OBS_IDS);
const observed_arb = fc.constantFrom(...OBSERVED_AT);

// ---------------------------------------------------------------------------
// Reference model
// ---------------------------------------------------------------------------

type ModelObs = {
	id: string;
	type: string;
	source: { store_id: string; version: string; path?: string };
	content: { value: string };
	confidence?: number;
	observed_at?: Date;
	entity_key?: string;
};

type ObsModel = {
	meta: Map<string, SnapshotMeta>;
	obs: Map<string, ModelObs>;
};

const meta_key = (store_id: string, version: string): string => `${store_id}:${version}`;
const fresh_model = (): ObsModel => ({ meta: new Map(), obs: new Map() });

type NormObs = {
	id: string;
	type: string;
	source: { store_id: string; version: string; path?: string };
	content?: unknown;
	confidence?: number;
	observed_at?: number;
	entity_key?: string;
};

type NormInput = {
	id: string;
	type: string;
	source: { store_id: string; version: string; path?: string };
	content?: unknown;
	confidence?: number;
	observed_at?: Date;
	entity_key?: string;
};

const norm = (o: NormInput, with_content: boolean): NormObs => ({
	id: o.id,
	type: o.type,
	source: {
		store_id: o.source.store_id,
		version: o.source.version,
		...(o.source.path === undefined ? {} : { path: o.source.path }),
	},
	...(with_content ? { content: o.content } : {}),
	...(o.confidence === undefined ? {} : { confidence: o.confidence }),
	...(o.observed_at === undefined ? {} : { observed_at: o.observed_at.getTime() }),
	...(o.entity_key === undefined ? {} : { entity_key: o.entity_key }),
});

const not_found = (id: string): CorpusError => ({ kind: "observation_not_found", id });
const id_collision = (id: string): CorpusError => ({
	kind: "validation_error",
	message: `observation id "${id}" already exists`,
	cause: new Error(`observation id "${id}" already exists`),
});

/** Newest snapshot of a store (optionally entity-scoped); ties go to the later insertion, as in every backend. */
const latest_version = (model: ObsModel, store_id: string, entity_key?: string): string | undefined => {
	const candidates = [...model.meta.values()].filter(
		(m) => m.store_id === store_id && (entity_key === undefined || m.entity_key === entity_key),
	);
	return candidates.reduce<SnapshotMeta | undefined>(
		(best, m) => (best === undefined || m.created_at.getTime() >= best.created_at.getTime() ? m : best),
		undefined,
	)?.version;
};

// Mirrors observations/client.ts is_stale.
const model_is_stale = (model: ObsModel, store_id: string, version: string): boolean => {
	const entity_key = model.meta.get(meta_key(store_id, version))?.entity_key;
	const latest = latest_version(model, store_id, entity_key);
	return latest !== undefined && version !== latest;
};

// ---------------------------------------------------------------------------
// Query filters
// ---------------------------------------------------------------------------

type VersionFilterSpec = { kind: "set" | "array" | "sync" | "async"; versions: string[] };

type Filters = {
	type?: string | string[];
	source_store?: string;
	source_version?: string;
	exclude_source_version?: string;
	source_prefix?: string;
	after?: Date;
	before?: Date;
	entity_key?: string;
	version_filter?: VersionFilterSpec;
	limit?: number;
};

// Filters are ANDed: each is absent ~75% of the time so queries regularly return rows.
const sparse = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
	fc.oneof({ weight: 3, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: arb });

const filters_arb: fc.Arbitrary<Filters> = fc
	.record({
		type: sparse(fc.oneof(type_arb, fc.subarray([...TYPE_NAMES], { minLength: 1 }))),
		source_store: sparse(store_arb),
		source_version: sparse(version_arb),
		exclude_source_version: sparse(version_arb),
		source_prefix: sparse(fc.constantFrom(...PREFIXES)),
		after: sparse(observed_arb),
		before: sparse(observed_arb),
		entity_key: sparse(fc.constantFrom("e1", "e2")),
		version_filter: sparse(
			fc.record({
				kind: fc.constantFrom("set", "array", "sync", "async"),
				versions: fc.subarray([...VERSIONS]),
			}),
		),
		limit: sparse(fc.integer({ min: 1, max: 5 })),
	})
	.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Filters);

const matches = (row: ModelObs, f: Filters): boolean => {
	const types = f.type === undefined ? undefined : Array.isArray(f.type) ? f.type : [f.type];
	const at = row.observed_at?.getTime();
	return (
		(types === undefined || types.includes(row.type)) &&
		(f.source_store === undefined || row.source.store_id === f.source_store) &&
		(f.source_version === undefined || row.source.version === f.source_version) &&
		(f.exclude_source_version === undefined || row.source.version !== f.exclude_source_version) &&
		(f.source_prefix === undefined || row.source.version.startsWith(f.source_prefix)) &&
		(f.after === undefined || (at !== undefined && at > f.after.getTime())) &&
		(f.before === undefined || (at !== undefined && at < f.before.getTime())) &&
		(f.entity_key === undefined || row.entity_key === f.entity_key) &&
		(f.version_filter === undefined || f.version_filter.versions.includes(row.source.version))
	);
};

const model_query = (model: ObsModel, f: Filters): ModelObs[] =>
	[...model.obs.values()]
		.toReversed()
		.filter((row) => matches(row, f))
		.slice(0, f.limit);

type SutQueryOpts = NonNullable<Parameters<ObservationsClient["query"]>[0]>;

const to_version_filter = (spec: VersionFilterSpec): NonNullable<SutQueryOpts["version_filter"]> => {
	if (spec.kind === "set") return new Set(spec.versions);
	if (spec.kind === "array") return [...spec.versions];
	if (spec.kind === "sync") return (_store_id, version) => spec.versions.includes(version);
	return async (_store_id, version) => {
		await Promise.resolve();
		return spec.versions.includes(version);
	};
};

const to_sut_opts = (f: Filters): SutQueryOpts => ({
	...(f.type === undefined ? {} : { type: f.type }),
	...(f.source_store === undefined ? {} : { source_store: f.source_store }),
	...(f.source_version === undefined ? {} : { source_version: f.source_version }),
	...(f.exclude_source_version === undefined ? {} : { exclude_source_version: f.exclude_source_version }),
	...(f.source_prefix === undefined ? {} : { source_prefix: f.source_prefix }),
	...(f.after === undefined ? {} : { after: f.after }),
	...(f.before === undefined ? {} : { before: f.before }),
	...(f.entity_key === undefined ? {} : { entity_key: f.entity_key }),
	...(f.version_filter === undefined ? {} : { version_filter: to_version_filter(f.version_filter) }),
	...(f.limit === undefined ? {} : { limit: f.limit }),
});

const describe_filters = (f: Filters): string => Object.keys(f).toSorted().join(",");

// ---------------------------------------------------------------------------
// Structural equality (undefined-valued keys count as absent)
// ---------------------------------------------------------------------------

const deep_equal = (a: unknown, b: unknown): boolean => {
	if (Object.is(a, b)) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deep_equal(v, b[i]));
	}
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		const rec_a = a as Record<string, unknown>;
		const rec_b = b as Record<string, unknown>;
		const keys_a = Object.keys(rec_a)
			.filter((k) => rec_a[k] !== undefined)
			.toSorted();
		const keys_b = Object.keys(rec_b)
			.filter((k) => rec_b[k] !== undefined)
			.toSorted();
		if (keys_a.length !== keys_b.length) return false;
		return keys_a.every((k, i) => k === keys_b[i] && deep_equal(rec_a[k], rec_b[k]));
	}
	return false;
};

// ---------------------------------------------------------------------------
// Commands — one equivalence_command per operation (8 types)
// ---------------------------------------------------------------------------

const command_counts = new Map<string, number>();
const bump = (type: string): void => {
	command_counts.set(type, (command_counts.get(type) ?? 0) + 1);
};

// Outcome labels ("query:nonempty") prove a command reached an interesting branch, not just ran.
const outcome_counts = new Map<string, number>();
const note = (label: string, happened: boolean): void => {
	if (happened) outcome_counts.set(label, (outcome_counts.get(label) ?? 0) + 1);
};

// Each must be >=2% of its command's calls.
const HIT_LABELS = ["query:nonempty", "delete_by_source:removed>0", "is_stale:true", "is_stale:false"] as const;

const obs_of = (backend: Backend): ObservationsClient => {
	if (!backend.observations) throw new Error("backend has no observations client");
	return backend.observations;
};

const put_snapshot_commands = fc
	.record({
		store_id: store_arb,
		version: version_arb,
		entity_key: entity_arb,
		created_at: fc.constantFrom(...SNAPSHOT_AT),
	})
	.map(({ store_id, version, entity_key, created_at }) =>
		equivalence_command<ObsModel, Backend, Result<void, CorpusError>>({
			label: `put_snapshot(${store_id}:${version},${String(entity_key)})`,
			on_model: (m) => {
				bump("put_snapshot");
				m.meta.set(meta_key(store_id, version), {
					store_id,
					version,
					parents: [],
					created_at,
					content_hash: `hash_${version}`,
					content_type: "application/json",
					size_bytes: 0,
					data_key: `${store_id}/hash_${version}`,
					...(entity_key === undefined ? {} : { entity_key }),
				});
				return ok(undefined);
			},
			on_sut: (b) =>
				b.metadata.put({
					store_id,
					version,
					parents: [],
					created_at,
					content_hash: `hash_${version}`,
					content_type: "application/json",
					size_bytes: 0,
					data_key: `${store_id}/hash_${version}`,
					...(entity_key === undefined ? {} : { entity_key }),
				}),
		}),
	);

const put_observation_commands = fc
	.record({
		id: id_arb,
		type: type_arb,
		store_id: store_arb,
		version: version_arb,
		path: path_arb,
		value: fc.constantFrom(...VALUES),
		entity_key: maybe(fc.constantFrom("e1", "e2")),
		observed_at: maybe(observed_arb),
		confidence: maybe(fc.constantFrom(0, 0.5, 1)),
	})
	.map((p) =>
		equivalence_command<ObsModel, Backend, Result<NormObs, CorpusError>>({
			label: `put_observation(${p.id},${p.type},${p.store_id}:${p.version})`,
			on_model: (m) => {
				bump("put_observation");
				if (m.obs.has(p.id)) return err(id_collision(p.id));
				const inherited = p.entity_key ?? m.meta.get(meta_key(p.store_id, p.version))?.entity_key;
				const row: ModelObs = {
					id: p.id,
					type: p.type,
					source: { store_id: p.store_id, version: p.version, ...(p.path === undefined ? {} : { path: p.path }) },
					content: { value: p.value },
					...(p.confidence === undefined ? {} : { confidence: p.confidence }),
					...(p.observed_at === undefined ? {} : { observed_at: p.observed_at }),
					...(inherited === undefined ? {} : { entity_key: inherited }),
				};
				m.obs.set(p.id, row);
				return ok(norm(row, true));
			},
			on_sut: async (b) => {
				const r = await obs_of(b).put(type_defs[p.type], {
					id: p.id,
					source: { store_id: p.store_id, version: p.version, ...(p.path === undefined ? {} : { path: p.path }) },
					content: { value: p.value },
					...(p.entity_key === undefined ? {} : { entity_key: p.entity_key }),
					...(p.observed_at === undefined ? {} : { observed_at: p.observed_at }),
					...(p.confidence === undefined ? {} : { confidence: p.confidence }),
				});
				return r.ok ? ok(norm(r.value, true)) : r;
			},
		}),
	);

const get_commands = id_arb.map((id) =>
	equivalence_command<ObsModel, Backend, Result<NormObs, CorpusError>>({
		label: `get(${id})`,
		on_model: (m) => {
			bump("get");
			const row = m.obs.get(id);
			return row === undefined ? err(not_found(id)) : ok(norm(row, true));
		},
		on_sut: async (b) => {
			const r = await obs_of(b).get(id);
			return r.ok ? ok(norm(r.value, true)) : r;
		},
	}),
);

const delete_commands = id_arb.map((id) =>
	equivalence_command<ObsModel, Backend, Result<void, CorpusError>>({
		label: `delete(${id})`,
		on_model: (m) => {
			bump("delete");
			return m.obs.delete(id) ? ok(undefined) : err(not_found(id));
		},
		on_sut: (b) => obs_of(b).delete(id),
	}),
);

const delete_by_source_commands = fc.record({ store_id: store_arb, version: version_arb, path: path_arb }).map((p) =>
	equivalence_command<ObsModel, Backend, Result<number, CorpusError>>({
		label: `delete_by_source(${p.store_id}:${p.version},${String(p.path)})`,
		on_model: (m) => {
			bump("delete_by_source");
			const doomed = [...m.obs.values()].filter(
				(row) =>
					row.source.store_id === p.store_id &&
					row.source.version === p.version &&
					(p.path === undefined || row.source.path === p.path),
			);
			note("delete_by_source:removed>0", doomed.length > 0);
			doomed.forEach((row) => m.obs.delete(row.id));
			return ok(doomed.length);
		},
		on_sut: (b) =>
			obs_of(b).delete_by_source({
				store_id: p.store_id,
				version: p.version,
				...(p.path === undefined ? {} : { path: p.path }),
			}),
	}),
);

const query_commands = filters_arb.map((f) =>
	equivalence_command<ObsModel, Backend, Result<NormObs[], CorpusError>>({
		label: `query(${describe_filters(f)})`,
		on_model: (m) => {
			bump("query");
			const rows = model_query(m, f);
			note("query:nonempty", rows.length > 0);
			return ok(rows.map((row) => norm(row, true)));
		},
		on_sut: async (b) => {
			const found: NormObs[] = [];
			for await (const o of obs_of(b).query(to_sut_opts(f))) found.push(norm(o, true));
			return ok(found);
		},
	}),
);

const query_meta_commands = filters_arb.map((f) =>
	equivalence_command<ObsModel, Backend, Result<NormObs[], CorpusError>>({
		label: `query_meta(${describe_filters(f)})`,
		on_model: (m) => {
			bump("query_meta");
			return ok(model_query(m, f).map((row) => norm(row, false)));
		},
		on_sut: async (b) => {
			const found: NormObs[] = [];
			for await (const o of obs_of(b).query_meta(to_sut_opts(f))) found.push(norm(o, false));
			return ok(found);
		},
	}),
);

const is_stale_commands = fc.record({ store_id: store_arb, version: version_arb }).map(({ store_id, version }) =>
	equivalence_command<ObsModel, Backend, boolean>({
		label: `is_stale(${store_id}:${version})`,
		on_model: (m) => {
			bump("is_stale");
			const stale = model_is_stale(m, store_id, version);
			note("is_stale:true", stale);
			note("is_stale:false", !stale);
			return stale;
		},
		on_sut: (b) => obs_of(b).is_stale({ store_id, version }),
	}),
);

const ALL_COMMAND_TYPES = [
	"put_snapshot",
	"put_observation",
	"get",
	"delete",
	"delete_by_source",
	"query",
	"query_meta",
	"is_stale",
] as const;

// ---------------------------------------------------------------------------
// Providers — fresh SUT per run; file dirs are unique per run and flushed
// eagerly (memory is the FIRST provider built each run, so its build is the
// between-runs cleanup point).
// ---------------------------------------------------------------------------

let dir_seq = 0;
const spawned_dirs: string[] = [];

const fresh_dir = (): string => {
	const dir = join(root, `run-${String(dir_seq++)}`);
	spawned_dirs.push(dir);
	return dir;
};

const flush_dirs = async (): Promise<void> => {
	await Promise.all(spawned_dirs.splice(0).map(remove_tmp_dir));
};

const build_remote = (): Backend => {
	if (!d1_http || !s3_fake) throw new Error("fake transports not started");
	d1_http.reset();
	s3_fake.reset();
	return create_remote_backend({
		account_id: "test-account",
		database_id: "test-database",
		api_token: "test-token",
		d1_base_url: d1_http.url,
		r2: {
			bucket: "test-bucket",
			access_key_id: "test-access-key-id",
			secret_access_key: "test-secret-access-key",
			endpoint: s3_fake.url,
		},
	});
};

describe("property: observations model-based equivalence", () => {
	beforeAll(async () => {
		root = await make_tmp_dir("observations-equivalence");
		d1_http = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3_fake = create_fake_s3();
	});

	afterAll(async () => {
		d1_http?.stop();
		s3_fake?.stop();
		await remove_tmp_dir(root);
	});

	test("memory, file, layered, cloudflare, remote agree with the reference model under arbitrary command sequences", async () => {
		const started = Date.now();

		await provider_equivalence<ObsModel, Backend>({
			model: fresh_model,
			providers: [
				{
					label: "memory",
					build: async () => {
						await flush_dirs();
						return create_memory_backend();
					},
				},
				{ label: "file", build: () => create_file_backend({ base_path: fresh_dir() }) },
				{
					label: "layered(memory over file)",
					build: () => {
						const cache = create_memory_backend();
						const disk = create_file_backend({ base_path: fresh_dir() });
						return create_layered_backend({ read: [cache, disk], write: [cache, disk] });
					},
				},
				{
					label: "cloudflare",
					build: () =>
						create_cloudflare_backend({
							d1: create_fake_d1([corpus_snapshots, corpus_observations]),
							r2: create_fake_r2(),
						}),
				},
				{ label: "remote", build: build_remote },
			],
			commands: [
				put_snapshot_commands,
				put_observation_commands,
				get_commands,
				delete_commands,
				delete_by_source_commands,
				query_commands,
				query_meta_commands,
				is_stale_commands,
			],
			equivalence: { results_agree: deep_equal },
			numRuns: 200,
			maxCommands: 30,
			size: "max",
		});

		expect(Date.now() - started).toBeLessThan(30_000);

		// Volume floor: 200 runs x 5 providers x avg >=8 commands/sequence = 8000
		// (size:"max" measures ~16/sequence; default sizing averages ~5).
		const total = [...command_counts.values()].reduce((sum, n) => sum + n, 0);
		expect(total).toBeGreaterThan(8_000);
		for (const type of ALL_COMMAND_TYPES) {
			const share = (command_counts.get(type) ?? 0) / total;
			expect(share).toBeGreaterThanOrEqual(0.03);
		}

		for (const label of HIT_LABELS) {
			const calls = command_counts.get(label.split(":")[0] ?? "") ?? 0;
			const rate = (outcome_counts.get(label) ?? 0) / calls;
			expect({ label, ok: rate >= 0.02, rate }).toEqual({ label, ok: true, rate });
		}
	}, 120_000);
});
