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
 * Backends under test: memory, file, layered (memory cache over file disk).
 *
 * CLOUDFLARE IS EXCLUDED: the D1/R2 backend is exercised against the same
 * behavioural contract via platform fakes in
 * tests/integration/backend-contract.test.ts and
 * tests/integration/cloudflare-backend.test.ts. The fake pair
 * (create_fake_d1([tables]) + create_fake_r2()) rebuilds Drizzle table
 * wiring per instance, which doesn't fit this pilot's fresh-SUT-per-run
 * protocol cheaply (200 runs x rebuild), and real D1/R2 runs live behind
 * wrangler out-of-band.
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
 * - data keys: `<store>/<hex>` with no "_" — the file backend's data_path
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
 * sizing averages only ~5 commands/sequence; "max" biases toward the cap,
 * measured avg ~16, max 30) x 3 providers. Measured at ~1 s locally — well
 * under the 30 s phase adversary gate, asserted below.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fc from "fast-check";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { provider_equivalence, equivalence_command } from "../../testing/laws/provider-equivalence.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import { create_layered_backend } from "../../backend/layered.js";
import { ok, err } from "../../types.js";
import type { Backend, CorpusError, Result, SnapshotMeta } from "../../types.js";

const ROOT = join(import.meta.dir, "..", ".tmp", "backend-equivalence");

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
});

/** Order-independent list comparison: canonical sort by version (unique per store). */
const canonical = (metas: NormMeta[]): NormMeta[] =>
  [...metas].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));

const to_hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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
    const keys_a = Object.keys(rec_a).filter((k) => rec_a[k] !== undefined).sort();
    const keys_b = Object.keys(rec_b).filter((k) => rec_b[k] !== undefined).sort();
    if (keys_a.length !== keys_b.length) return false;
    return keys_a.every((k, i) => k === keys_b[i] && deep_equal(rec_a[k], rec_b[k]));
  }
  return false;
};

// ---------------------------------------------------------------------------
// Payload arbitraries — plain fc.*, pooled for cross-command interaction
// ---------------------------------------------------------------------------

const STORE_IDS = ["alpha", "beta", "gamma"] as const;
const VERSIONS = ["v1", "v2", "v3", "v4", "v5", "v6"] as const;
const DATA_KEYS = [
  "alpha/0a1b2c3d",
  "alpha/4e5f6071",
  "beta/8293a4b5",
  "beta/c6d7e8f9",
  "gamma/1f2e3d4c",
  "gamma/5b6a7988",
] as const;

const store_id_arb = fc.constantFrom(...STORE_IDS);
const version_arb = fc.constantFrom(...VERSIONS);
const data_key_arb = fc.constantFrom(...DATA_KEYS);
const date_arb = fc.date({
  min: new Date("2000-01-01T00:00:00.000Z"),
  max: new Date("2100-01-01T00:00:00.000Z"),
  noInvalidDate: true,
});

const meta_arb: fc.Arbitrary<SnapshotMeta> = fc.record({
  store_id: store_id_arb,
  version: version_arb,
  parents: fc.array(fc.record({ store_id: store_id_arb, version: version_arb }), { maxLength: 2 }),
  created_at: date_arb,
  invoked_at: fc.option(date_arb, { nil: undefined }),
  content_hash: fc.stringMatching(/^[a-f0-9]{16}$/),
  content_type: fc.constantFrom("application/json", "text/plain", "application/octet-stream"),
  size_bytes: fc.nat({ max: 1_000_000 }),
  data_key: data_key_arb,
  tags: fc.option(fc.array(fc.constantFrom("draft", "reviewed", "hot"), { maxLength: 3 }), {
    nil: undefined,
  }),
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

const get_meta_commands = fc
  .record({ store_id: store_id_arb, version: version_arb })
  .map(({ store_id, version }) =>
    equivalence_command<BackendModel, Backend, Result<NormMeta, CorpusError>>({
      label: `get_meta(${store_id}:${version})`,
      on_model: (m) => {
        bump("get_meta");
        const meta = m.meta.get(meta_key(store_id, version));
        return meta === undefined ? err({ kind: "not_found", store_id, version }) : ok(norm_meta(meta));
      },
      on_sut: async (b) => {
        const r = await b.metadata.get(store_id, version);
        return r.ok ? ok(norm_meta(r.value)) : r;
      },
    }),
  );

const delete_meta_commands = fc
  .record({ store_id: store_id_arb, version: version_arb })
  .map(({ store_id, version }) =>
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

const list_meta_commands = store_id_arb.map((store_id) =>
  equivalence_command<BackendModel, Backend, Result<NormMeta[], CorpusError>>({
    label: `list_meta(${store_id})`,
    on_model: (m) => {
      bump("list_meta");
      const metas = [...m.meta.values()].filter((meta) => meta.store_id === store_id);
      return ok(canonical(metas.map(norm_meta)));
    },
    on_sut: async (b) => {
      const collected: SnapshotMeta[] = [];
      for await (const meta of b.metadata.list(store_id)) collected.push(meta);
      return ok(canonical(collected.map(norm_meta)));
    },
  }),
);

const put_data_commands = fc
  .record({ data_key: data_key_arb, bytes: fc.uint8Array({ maxLength: 64 }) })
  .map(({ data_key, bytes }) =>
    equivalence_command<BackendModel, Backend, Result<void, CorpusError>>({
      label: `put_data(${data_key},${bytes.length}B)`,
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
      return bytes === undefined
        ? err({ kind: "not_found", store_id: data_key, version: "" })
        : ok(to_hex(bytes));
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
  "put_data",
  "get_data",
  "delete_data",
  "exists_data",
] as const;

// ---------------------------------------------------------------------------
// Providers — fresh SUT per run; file-backed dirs are unique per run and the
// previous run's dirs are flushed eagerly (memory is the FIRST provider
// built each run, so its build is the between-runs cleanup point).
// ---------------------------------------------------------------------------

let dir_seq = 0;
const spawned_dirs: string[] = [];

const fresh_dir = (): string => {
  const dir = join(ROOT, `run-${dir_seq++}`);
  spawned_dirs.push(dir);
  return dir;
};

const flush_dirs = async (): Promise<void> => {
  const doomed = spawned_dirs.splice(0);
  await Promise.all(doomed.map((dir) => rm(dir, { recursive: true, force: true })));
};

describe("property: cross-backend model-based equivalence", () => {
  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  test(
    "memory, file, layered backends agree with the reference model under arbitrary command sequences",
    async () => {
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
        ],
        commands: [
          put_meta_commands,
          get_meta_commands,
          delete_meta_commands,
          list_meta_commands,
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

      // Volume floor: 200 runs x 3 providers x avg >=8 commands/sequence.
      // Only holds when the size:"max" passthrough works (default sizing
      // averages ~4.7/sequence => ~2800 total; size:"max" measures ~9500).
      const total = [...command_counts.values()].reduce((sum, n) => sum + n, 0);
      expect(total).toBeGreaterThan(4_800);
      for (const type of ALL_COMMAND_TYPES) {
        const share = (command_counts.get(type) ?? 0) / total;
        expect(share).toBeGreaterThanOrEqual(0.05);
      }
    },
    60_000,
  );
});
