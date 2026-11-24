/**
 * Property pilot: cross-backend model-based equivalence (plan task 3.4).
 *
 * Runs shrinkable command sequences against a hand-rolled reference model
 * (two plain Maps — NOT a backend) and three real backends, asserting per
 * command that every backend agrees with the model:
 *
 * - `ok` flags agree
 * - ok values structurally equal (Dates compared at ms precision via epoch
 *   normalisation — the file backend round-trips ISO-8601 with full ms)
 * - err → `error.kind` matches (compared centrally by provider_equivalence)
 * - `list` results order-independent: both arms canonical-sort by version,
 *   so extra/missing/duplicate entries still diverge (stronger than a Set)
 *
 * Backends under test: memory, file, layered (memory cache over file disk),
 * cloudflare (real Drizzle d1 driver over the bun:sqlite D1 fake + Map R2
 * fake), remote (real remote backend over the D1-HTTP and S3 fake servers)
 * and wrapped-bytes (memory metadata + a data client over wrap_bytes_storage).
 *
 * SHARED TRANSPORT: the remote provider starts ONE create_fake_d1_http +
 * create_fake_s3 pair per file (beforeAll) and stops it in afterAll. Each
 * `build` calls `reset()` on both BEFORE constructing a fresh backend, so
 * every run sees empty state without a server restart. Cloudflare rebuilds
 * its fakes per run (cheap enough at 200 runs).
 *
 * LAYERED SCOPE: all commands here are direct (non-transactional)
 * `metadata.*` / `data.*` ops, which the layered backend fans out to BOTH
 * write layers — cache and disk stay symmetric. The documented cache
 * asymmetry (AGENTS.md gotcha: layered `apply_batch` forwards to the bottom
 * write layer only) applies to transactional writes, which are deliberately
 * out of scope for this pilot.
 *
 * PAYLOAD DOMAINS are pooled/constrained on purpose so commands interact
 * (get/delete hit prior puts) AND to stay inside each backend's documented
 * key contract rather than fuzzing filesystem naming:
 * - store ids / versions: alphanumeric, no ":" (memory backend's meta key
 *   separator), no "" (empty store_id is the internal list-all sentinel),
 *   no leading "_"/"." (file backend's list_all_stores filter).
 * - data keys: `<store>/<hex>` with no "_" (independent of store_id, so the
 *   "a_b" store still uses these keys) — the file backend's data_path
 *   sanitises "/" to "_", so "a/b" and "a_b" alias to the same file. That
 *   aliasing is a latent collision hazard (noted in the task report), not a
 *   behaviour this pilot fuzzes.
 * - dates clamped to 2000-2100 (AGENTS.md: unclamped fc.date() emits
 *   BC-era timestamps that break ISO round-trip expectations elsewhere).
 *
 * Payload arbitraries are plain `fc.*` — NOT testing.compose — so
 * fast-check's command shrinker terminates (see provider_equivalence's
 * warning about fc.gen()-based shrinking).
 *
 * Budget: numRuns=200 x maxCommands=30 (size:"max" — fast-check's default
 * sizing averages only ~5 commands/sequence; "max" biases toward the cap)
 * x 6 providers, asserted under 30 s below.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { join } from "node:path";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";
import { provider_equivalence, equivalence_command } from "../../testing/laws/provider-equivalence.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import { create_layered_backend } from "../../backend/layered.js";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_remote_backend } from "../../backend/remote.js";
import { create_data_client, wrap_bytes_storage } from "../../backend/base.js";
import type { BytesStorage } from "../../backend/base.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations } from "../../observations/schema.js";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import { create_fake_d1_http } from "../fakes/d1-http.js";
import type { FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3 } from "../fakes/s3.js";
import type { FakeS3Server } from "../fakes/s3.js";
import { ok, err } from "../../types.js";
import type { Backend, CorpusError, ListOpts, Result, SnapshotMeta } from "../../types.js";

let root = "";
let d1_http: FakeD1HttpServer | undefined;
let s3_server: FakeS3Server | undefined;

// ---------------------------------------------------------------------------
// Reference model — plain Maps with hand-rolled semantics, NOT a backend.
// ---------------------------------------------------------------------------

type BackendModel = {
	meta: Map<string, SnapshotMeta>;
	data: Map<string, Uint8Array>;
};

const meta_key = (store_id: string, version: string): string => `${store_id}:${version}`;
const fresh_model = (): BackendModel => ({ meta: new Map(), data: new Map() });

// ---------------------------------------------------------------------------
// Normalisation + structural equality
// ---------------------------------------------------------------------------

type NormMeta = {
	store_id: string;
	version: string;
	parents: ReadonlyArray<{ store_id: string; version: string; role?: string }>;
	created_at: number;
	invoked_at?: number;
	content_hash: string;
	content_type: string;
	size_bytes: number;
	data_key: string;
	tags?: readonly string[];
	entity_key?: string;
};

/**
 * Dates → epoch ms (exact — ms IS the Date precision; the file backend's
 * JSON round-trip preserves it). Absent-vs-undefined optional fields are
 * unified: memory returns the stored object verbatim (`invoked_at:
 * undefined` present), the file backend's JSON round-trip drops the key.
 * That serialisation artefact is the ONLY difference normalised away here.
 */
const norm_meta = (m: SnapshotMeta): NormMeta => ({
	store_id: m.store_id,
	version: m.version,
	parents: m.parents.map((p) => ({
		store_id: p.store_id,
		version: p.version,
		...(p.role === undefined ? {} : { role: p.role }),
	})),
	created_at: m.created_at.getTime(),
	...(m.invoked_at === undefined ? {} : { invoked_at: m.invoked_at.getTime() }),
	content_hash: m.content_hash,
	content_type: m.content_type,
	size_bytes: m.size_bytes,
	data_key: m.data_key,
	...(m.tags === undefined ? {} : { tags: [...m.tags] }),
	...(m.entity_key === undefined ? {} : { entity_key: m.entity_key }),
});

const version_order = (a: NormMeta, b: NormMeta): number => {
	const ka = `${a.store_id}:${a.version}`;
	const kb = `${b.store_id}:${b.version}`;
	return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** Order-independent comparison (get_children): canonical sort by store:version (unique). */
const canonical = (metas: NormMeta[]): NormMeta[] => metas.toSorted(version_order);

const to_hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Structural deep-equal; keys with `undefined` values are treated as absent. */
const deep_equal = (a: unknown, b: unknown): boolean => {
	if (Object.is(a, b)) return true;
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
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
// Payload arbitraries — plain fc.*, pooled for cross-command interaction
// ---------------------------------------------------------------------------

// "alp" is a prefix of "alpha" and "a_b"/"axb" differ only by a LIKE wildcard.
const STORE_IDS = ["alpha", "alp", "beta", "a_b", "axb"] as const;
const VERSIONS = ["v1", "v2", "v3", "v4", "v5", "v6"] as const;
const DATA_KEYS = [
	"alpha/0a1b2c3d",
	"alpha/4e5f6071",
	"beta/8293a4b5",
	"beta/c6d7e8f9",
	"gamma/1f2e3d4c",
	"gamma/5b6a7988",
] as const;

// "alpha" is drawn ~4x as often so one store regularly accumulates several metas
// (limit / tie-break / tag paths need depth); the colliders ("alp", "a_b", "axb") still appear.
const store_id_arb = fc.oneof(
	{ weight: 4, arbitrary: fc.constant<(typeof STORE_IDS)[number]>("alpha") },
	{ weight: 3, arbitrary: fc.constantFrom(...STORE_IDS) },
);
const version_arb = fc.constantFrom(...VERSIONS);
const data_key_arb = fc.constantFrom(...DATA_KEYS);
const HASHES = ["0123456789abcdef", "fedcba9876543210", "a1b2c3d4e5f60789"] as const;
const hash_arb = fc.constantFrom(...HASHES);
const entity_arb = fc.constantFrom("e1", "e2");
// Four fixed instants: ties on created_at and before/after boundary hits are routine.
const CREATED_POOL = [
	new Date("2024-01-01T00:00:00.000Z"),
	new Date("2024-01-02T00:00:00.000Z"),
	new Date("2024-01-03T00:00:00.000Z"),
	new Date("2024-01-04T00:00:00.000Z"),
] as const;
const created_arb = fc.constantFrom(...CREATED_POOL);
const date_arb = fc.date({
	min: new Date("2000-01-01T00:00:00.000Z"),
	max: new Date("2100-01-01T00:00:00.000Z"),
	noInvalidDate: true,
});

const meta_arb: fc.Arbitrary<SnapshotMeta> = fc.record({
	store_id: store_id_arb,
	version: version_arb,
	parents: fc.array(fc.record({ store_id: store_id_arb, version: version_arb }), { maxLength: 2 }),
	created_at: created_arb,
	invoked_at: fc.option(date_arb, { nil: undefined }),
	content_hash: hash_arb,
	content_type: fc.constantFrom("application/json", "text/plain", "application/octet-stream"),
	size_bytes: fc.nat({ max: 1_000_000 }),
	data_key: data_key_arb,
	tags: fc.option(fc.array(fc.constantFrom("draft", "reviewed", "hot"), { maxLength: 3 }), {
		nil: undefined,
	}),
	entity_key: fc.option(entity_arb, { nil: undefined }),
});

// ---------------------------------------------------------------------------
// Commands — one equivalence_command per backend operation (8 types).
// Coverage is counted per type so the >=5%-each adversary gate is asserted,
// not eyeballed.
// ---------------------------------------------------------------------------

const command_counts = new Map<string, number>();
const bump = (type: string): void => {
	command_counts.set(type, (command_counts.get(type) ?? 0) + 1);
};

// Outcome labels ("get_meta:hit") prove a command reached an interesting branch, not just ran.
const outcome_counts = new Map<string, number>();
const note = (label: string, happened: boolean): void => {
	if (happened) outcome_counts.set(label, (outcome_counts.get(label) ?? 0) + 1);
};

const put_meta_commands = meta_arb.map((meta) =>
	equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
		label: `put_meta(${meta.store_id}:${meta.version})`,
		on_model: (m) => {
			bump("put_meta");
			m.meta.set(meta_key(meta.store_id, meta.version), meta);
			return ok(undefined);
		},
		on_sut: (b) => b.metadata.put(meta),
	}),
);

// Several puts into ONE store in a single command: sequences average ~8 commands, so
// single puts rarely stack enough metas for limit / tie-break / filter paths to bite.
const put_burst_commands = fc
	.record({ store_id: store_id_arb, metas: fc.array(meta_arb, { minLength: 2, maxLength: 5 }) })
	.map(({ store_id, metas: drawn }) => {
		const metas = drawn.map((meta) => ({ ...meta, store_id }));
		return equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
			label: `put_burst(${store_id}x${String(metas.length)})`,
			on_model: (m) => {
				bump("put_meta");
				for (const meta of metas) m.meta.set(meta_key(meta.store_id, meta.version), meta);
				return ok(undefined);
			},
			on_sut: async (b) => {
				for (const meta of metas) {
					const r = await b.metadata.put(meta);
					if (!r.ok) return r;
				}
				return ok(undefined);
			},
		});
	});

const get_meta_commands = fc.record({ store_id: store_id_arb, version: version_arb }).map(({ store_id, version }) =>
	equivalence_command<BackendModel, Backend, Result<NormMeta, CorpusError>>({
		label: `get_meta(${store_id}:${version})`,
		on_model: (m) => {
			bump("get_meta");
			const meta = m.meta.get(meta_key(store_id, version));
			note("get_meta:hit", meta !== undefined);
			note("get_meta:miss", meta === undefined);
			return meta === undefined ? err({ kind: "not_found", store_id, version }) : ok(norm_meta(meta));
		},
		on_sut: async (b) => {
			const r = await b.metadata.get(store_id, version);
			return r.ok ? ok(norm_meta(r.value)) : r;
		},
	}),
);

const delete_meta_commands = fc.record({ store_id: store_id_arb, version: version_arb }).map(({ store_id, version }) =>
	equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
		label: `delete_meta(${store_id}:${version})`,
		on_model: (m) => {
			bump("delete_meta");
			m.meta.delete(meta_key(store_id, version));
			return ok(undefined);
		},
		on_sut: (b) => b.metadata.delete(store_id, version),
	}),
);

const ordered_filtered = (m: BackendModel, store_id: string, opts: ListOpts): NormMeta[] => {
	// Map iteration order IS insertion order (re-put keeps position, like the backends).
	const in_store = [...m.meta.values()].filter((meta) => meta.store_id === store_id);
	const kept = in_store
		.filter((meta) => opts.before === undefined || meta.created_at < opts.before)
		.filter((meta) => opts.after === undefined || meta.created_at > opts.after)
		.filter((meta) => (opts.tags ?? []).every((tag) => meta.tags?.includes(tag) === true))
		.filter((meta) => opts.entity_key === undefined || meta.entity_key === opts.entity_key);
	// Newest created_at first; ties: later insertion first (reverse before the stable sort).
	const sorted = kept.toReversed().toSorted((a, b) => b.created_at.getTime() - a.created_at.getTime());
	return (opts.limit === undefined ? sorted : sorted.slice(0, opts.limit)).map(norm_meta);
};

// fc.option's nil share tops out at 50%; filters are ANDed, so each is absent ~75% of the time
// to keep filtered listings regularly non-empty and limit-truncated.
const sparse = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
	fc.oneof({ weight: 3, arbitrary: fc.constant(undefined) }, { weight: 1, arbitrary: arb });

const list_opts_arb: fc.Arbitrary<ListOpts> = fc
	.record({
		limit: fc.option(fc.integer({ min: 1, max: 2 }), { nil: undefined, freq: 2 }),
		tags: sparse(fc.uniqueArray(fc.constantFrom("draft", "reviewed", "hot"), { maxLength: 2 })),
		before: sparse(created_arb),
		after: sparse(created_arb),
		entity_key: sparse(entity_arb),
	})
	.map((o) => ({
		...(o.limit === undefined ? {} : { limit: o.limit }),
		...(o.tags === undefined ? {} : { tags: o.tags }),
		...(o.before === undefined ? {} : { before: o.before }),
		...(o.after === undefined ? {} : { after: o.after }),
		...(o.entity_key === undefined ? {} : { entity_key: o.entity_key }),
	}));

const list_meta_commands = store_id_arb.map((store_id) =>
	equivalence_command<BackendModel, Backend, Result<NormMeta[], CorpusError>>({
		label: `list_meta(${store_id})`,
		on_model: (m) => {
			bump("list_meta");
			return ok(ordered_filtered(m, store_id, {}));
		},
		on_sut: async (b) => {
			const collected: SnapshotMeta[] = [];
			for await (const meta of b.metadata.list(store_id)) collected.push(meta);
			return ok(collected.map(norm_meta));
		},
	}),
);

// Filtered listings mostly target "alpha": a limit only truncates a store holding more metas than the limit.
const list_store_id_arb = fc.oneof(
	{ weight: 3, arbitrary: fc.constant<(typeof STORE_IDS)[number]>("alpha") },
	{ weight: 1, arbitrary: store_id_arb },
);

const list_meta_filtered_commands = fc
	.record({ store_id: list_store_id_arb, opts: list_opts_arb })
	.map(({ store_id, opts }) =>
		equivalence_command<BackendModel, Backend, Result<NormMeta[], CorpusError>>({
			label: `list_meta_filtered(${store_id})`,
			on_model: (m) => {
				bump("list_meta_filtered");
				const result = ordered_filtered(m, store_id, opts);
				note("list_meta_filtered:nonempty", result.length > 0);
				note("list_meta_filtered:empty", result.length === 0);
				note(
					"list_meta_filtered:limited",
					result.length < ordered_filtered(m, store_id, { ...opts, limit: undefined }).length,
				);
				return ok(result);
			},
			on_sut: async (b) => {
				const collected: SnapshotMeta[] = [];
				for await (const meta of b.metadata.list(store_id, opts)) collected.push(meta);
				return ok(collected.map(norm_meta));
			},
		}),
	);

const get_latest_commands = fc
	.record({ store_id: store_id_arb, entity_key: fc.option(entity_arb, { nil: undefined }) })
	.map(({ store_id, entity_key }) =>
		equivalence_command<BackendModel, Backend, Result<NormMeta, CorpusError>>({
			label: `get_latest(${store_id})`,
			on_model: (m) => {
				bump("get_latest");
				const candidates = [...m.meta.values()].filter(
					(meta) => meta.store_id === store_id && (entity_key === undefined || meta.entity_key === entity_key),
				);
				const latest = candidates.reduce<SnapshotMeta | undefined>(
					(best, meta) => (best === undefined || meta.created_at >= best.created_at ? meta : best),
					undefined,
				);
				note("get_latest:hit", latest !== undefined);
				note("get_latest:miss", latest === undefined);
				note(
					"get_latest:tie",
					latest !== undefined &&
						candidates.filter((meta) => meta.created_at.getTime() === latest.created_at.getTime()).length >= 2,
				);
				return latest === undefined ? err({ kind: "not_found", store_id, version: "latest" }) : ok(norm_meta(latest));
			},
			on_sut: async (b) => {
				const r = await b.metadata.get_latest(store_id, entity_key === undefined ? undefined : { entity_key });
				return r.ok ? ok(norm_meta(r.value)) : r;
			},
		}),
	);

const get_children_commands = fc.record({ store_id: store_id_arb, version: version_arb }).map(({ store_id, version }) =>
	equivalence_command<BackendModel, Backend, Result<NormMeta[], CorpusError>>({
		label: `get_children(${store_id}:${version})`,
		on_model: (m) => {
			bump("get_children");
			const children = [...m.meta.values()].filter((meta) =>
				meta.parents.some((p) => p.store_id === store_id && p.version === version),
			);
			note("get_children:nonempty", children.length > 0);
			return ok(canonical(children.map(norm_meta)));
		},
		on_sut: async (b) => {
			const collected: SnapshotMeta[] = [];
			for await (const meta of b.metadata.get_children(store_id, version)) collected.push(meta);
			return ok(canonical(collected.map(norm_meta)));
		},
	}),
);

type HashHit = { found: boolean; store_id?: string; content_hash?: string };

const find_by_hash_commands = fc.record({ store_id: store_id_arb, hash: hash_arb }).map(({ store_id, hash }) =>
	equivalence_command<BackendModel, Backend, HashHit>({
		label: `find_by_hash(${store_id},${hash})`,
		on_model: (m) => {
			bump("find_by_hash");
			const hit = [...m.meta.values()].some((meta) => meta.store_id === store_id && meta.content_hash === hash);
			note("find_by_hash:found", hit);
			note("find_by_hash:absent", !hit);
			return hit ? { found: true, store_id, content_hash: hash } : { found: false };
		},
		// Backends may return ANY matching version: never compare it.
		on_sut: async (b) => {
			const meta = await b.metadata.find_by_hash(store_id, hash);
			return meta === null
				? { found: false }
				: { found: true, store_id: meta.store_id, content_hash: meta.content_hash };
		},
	}),
);

const list_stores_commands = fc.constant(null).map(() =>
	equivalence_command<BackendModel, Backend, Result<string[], CorpusError>>({
		label: "list_stores()",
		on_model: (m) => {
			bump("list_stores");
			return ok([...new Set([...m.meta.values()].map((meta) => meta.store_id))].toSorted());
		},
		on_sut: async (b) => {
			if (!b.metadata.list_stores) throw new Error("backend lacks list_stores");
			const ids: string[] = [];
			for await (const id of b.metadata.list_stores()) ids.push(id);
			return ok(ids);
		},
	}),
);

const put_data_commands = fc
	.record({ data_key: data_key_arb, bytes: fc.uint8Array({ maxLength: 64 }) })
	.map(({ data_key, bytes }) =>
		equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
			label: `put_data(${data_key},${String(bytes.length)}B)`,
			on_model: (m) => {
				bump("put_data");
				m.data.set(data_key, bytes);
				return ok(undefined);
			},
			on_sut: (b) => b.data.put(data_key, bytes),
		}),
	);

const get_data_commands = data_key_arb.map((data_key) =>
	equivalence_command<BackendModel, Backend, Result<string, CorpusError>>({
		label: `get_data(${data_key})`,
		on_model: (m) => {
			bump("get_data");
			const bytes = m.data.get(data_key);
			return bytes === undefined ? err({ kind: "not_found", store_id: data_key, version: "" }) : ok(to_hex(bytes));
		},
		on_sut: async (b) => {
			const r = await b.data.get(data_key);
			if (!r.ok) return r;
			return ok(to_hex(await r.value.bytes()));
		},
	}),
);

const delete_data_commands = data_key_arb.map((data_key) =>
	equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
		label: `delete_data(${data_key})`,
		on_model: (m) => {
			bump("delete_data");
			m.data.delete(data_key);
			return ok(undefined);
		},
		on_sut: (b) => b.data.delete(data_key),
	}),
);

const exists_data_commands = data_key_arb.map((data_key) =>
	equivalence_command<BackendModel, Backend, boolean>({
		label: `exists_data(${data_key})`,
		on_model: (m) => {
			bump("exists_data");
			return m.data.has(data_key);
		},
		on_sut: (b) => b.data.exists(data_key),
	}),
);

const ALL_COMMAND_TYPES = [
	"put_meta",
	"get_meta",
	"delete_meta",
	"list_meta",
	"list_meta_filtered",
	"get_latest",
	"get_children",
	"find_by_hash",
	"list_stores",
	"put_data",
	"get_data",
	"delete_data",
	"exists_data",
] as const;

// Each must be >=2% of its command's calls: the model exercises both sides of the branch.
const HIT_LABELS = [
	"get_meta:hit",
	"get_meta:miss",
	"list_meta_filtered:nonempty",
	"list_meta_filtered:empty",
	"list_meta_filtered:limited",
	"get_latest:hit",
	"get_latest:miss",
	"get_latest:tie",
	"find_by_hash:found",
	"find_by_hash:absent",
	"get_children:nonempty",
] as const;

const map_storage = (): BytesStorage => {
	const bytes = new Map<string, Uint8Array>();
	return {
		get: (key) => Promise.resolve(bytes.get(key) ?? null),
		put: (key, data) => {
			bytes.set(key, data);
			return Promise.resolve();
		},
		delete: (key) => {
			bytes.delete(key);
			return Promise.resolve();
		},
		exists: (key) => Promise.resolve(bytes.has(key)),
	};
};

// ---------------------------------------------------------------------------
// Providers — fresh SUT per run; file-backed dirs are unique per run and the
// previous run's dirs are flushed eagerly (memory is the FIRST provider
// built each run, so its build is the between-runs cleanup point).
// ---------------------------------------------------------------------------

let dir_seq = 0;
const spawned_dirs: string[] = [];

const fresh_dir = (): string => {
	const dir = join(root, `run-${String(dir_seq++)}`);
	spawned_dirs.push(dir);
	return dir;
};

const flush_dirs = async (): Promise<void> => {
	const doomed = spawned_dirs.splice(0);
	await Promise.all(doomed.map(remove_tmp_dir));
};

describe("property: cross-backend model-based equivalence", () => {
	beforeAll(async () => {
		root = await make_tmp_dir("backend-equivalence");
		d1_http = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3_server = create_fake_s3();
	});

	afterAll(async () => {
		d1_http?.stop();
		s3_server?.stop();
		await remove_tmp_dir(root);
	});

	test("memory, file, layered, cloudflare, remote, wrapped-bytes backends agree with the reference model under arbitrary command sequences", async () => {
		const started = Date.now();

		await provider_equivalence<BackendModel, Backend>({
			model: fresh_model,
			providers: [
				{
					label: "memory",
					build: async () => {
						await flush_dirs();
						return create_memory_backend();
					},
				},
				{
					label: "file",
					build: () => create_file_backend({ base_path: fresh_dir() }),
				},
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
				{
					label: "remote",
					build: () => {
						if (!d1_http || !s3_server) throw new Error("fake servers not started");
						d1_http.reset();
						s3_server.reset();
						return create_remote_backend({
							account_id: "test-account",
							database_id: "test-database",
							api_token: "test-token",
							d1_base_url: d1_http.url,
							r2: {
								bucket: "test-bucket",
								access_key_id: "test-access-key-id",
								secret_access_key: "test-secret-access-key",
								endpoint: s3_server.url,
							},
						});
					},
				},
				{
					label: "wrapped-bytes",
					build: () => ({
						...create_memory_backend(),
						data: create_data_client(wrap_bytes_storage(map_storage()), () => {}),
					}),
				},
			],
			commands: [
				put_meta_commands,
				put_burst_commands,
				put_burst_commands,
				get_meta_commands,
				delete_meta_commands,
				list_meta_commands,
				list_meta_filtered_commands,
				get_latest_commands,
				get_children_commands,
				find_by_hash_commands,
				list_stores_commands,
				put_data_commands,
				get_data_commands,
				delete_data_commands,
				exists_data_commands,
			],
			equivalence: { results_agree: deep_equal },
			numRuns: 200,
			maxCommands: 30,
			size: "max",
		});

		const elapsed = Date.now() - started;
		expect(elapsed).toBeLessThan(30_000);

		// Volume floor: on_model runs once per provider per command, so the
		// counter sees 200 runs x 6 providers x avg >=8 commands/sequence =
		// 9,600 (size:"max" averages ~16; default sizing ~4.7 would give ~5,600).
		const total = [...command_counts.values()].reduce((sum, n) => sum + n, 0);
		expect(total).toBeGreaterThan(9_600);
		for (const type of ALL_COMMAND_TYPES) {
			const share = (command_counts.get(type) ?? 0) / total;
			expect(share).toBeGreaterThanOrEqual(0.03);
		}

		for (const label of HIT_LABELS) {
			const calls = command_counts.get(label.split(":")[0] ?? "") ?? 0;
			const rate = (outcome_counts.get(label) ?? 0) / calls;
			expect({ label, ok: rate >= 0.02, rate }).toEqual({ label, ok: true, rate });
		}
	}, 60_000);
});
