# Phase 3 coder briefs: shared contracts and model-based expansion

Plan: `.plans/test-suite-yield.html#phase-3`
Devpad: `task_2bae1617-e27a-4fb5-b4dc-94e2a36cf41c`
Branch: `test/suite-yield`, base HEAD `8d9b35c`. Every claim below was checked against `8d9b35c`.

## Integration order (read first)

| Wave | Task (commit) | Worktree | Runs | Gate (reviewer) |
|---|---|---|---|---|
| 0 | 3.0 (C8a): `ObservationPutOpts.id?` + layered shared-id fan-out (Q7 = A; public API addition) | `p3-layered-obs` | parallel with 3.F | gate + `bun run docs:build` + `mutate tests/mutations/guards.ts` (3 new guards) |
| 0 | 3.F (C8b): `reset()` hooks on the D1-HTTP and S3 fakes | `p3-fake-reset` | parallel with 3.0 | gate. Then the reviewer **measures** timings (below) before Wave 1 is dispatched. |
| 1 | 3.1 (C8): observations contract suite and equivalence model | `p3-observations` | parallel | deletion rule + `mutate tests/mutations/observations.ts` |
| 1 | 3.2 (C9): backend-equivalence expansion | `p3-backend-model` | parallel | `coverage:diff` + `mutate tests/mutations/backend-model.ts` + timing budget |
| 1 | 3.4 (C11): memory/layered duplicates | `p3-store-level` | parallel | deletion rule + `mutate tests/mutations/store-level.ts` |
| 2 | 3.3 (C10): prune backend-contract, delete `remote-r2.test.ts` | `p3-contract-prune` | **sequential, after 3.2 is committed** | deletion rule + `mutate tests/mutations/backend-contract.ts` (`--base` = the C9 commit) |

- Every Wave 1 worktree branches from the tip **after** Wave 0 is committed, so all of them see `reset()` and the layered fix.
- Pruning is last. 3.3 may only delete contract assertions once C9 is committed and its manifest has proven the model kills their mutants on all providers.
- The reviewer gates each worktree in place (symlink `node_modules`), cherry-picks linearly, then re-runs `coverage:diff --base 6171c87` and `mutate tests/mutations/guards.ts` on the integrated tip.

**Wave 0 timing measurement (reviewer, before dispatching 3.2).** Use a throwaway script outside the repo and time:
- 200× `create_fake_d1([corpus_snapshots, corpus_observations])` plus `create_fake_r2()`;
- 200× `d1_http.reset(); s3.reset()` against one live pair;
- one 30-command remote sequence.

Record the numbers in the Phase 3 proof. Decision Q1(b) says full 200 runs for every provider. If the projected `backend-equivalence` runtime exceeds its 30 s budget assertion, stop and report. Don't silently lower `numRuns`.

---

## Shared header (paste above every brief)

> **Where you work**
> - Repo `/Users/tom/dev/corpus`. Work ONLY in your assigned worktree.
> - Plan: `.plans/test-suite-yield.html#phase-3`. Read AD-1, AD-2, AD-4, AD-5 and AD-6.
> - Devpad: `task_2bae1617-e27a-4fb5-b4dc-94e2a36cf41c`.
>
> **You have no shell and no delete tool.** You write and edit files only. **To delete a file, list it under "Reviewer deletions" in your final report**; the reviewer runs `git rm`. Never leave a file emptied or stubbed out instead. Then state, for each acceptance item, how your diff satisfies it.
>
> **Verify against HEAD before you write**
> - Every function, field, test name and `find` string you reference must exist in your worktree. Read the lib file first.
> - Two Phase 2 briefs cited code that didn't exist, and they produced equivalent mutants. If something in this brief doesn't match the code, **follow the code and say so in your report**.
>
> **Deletion rule.** The reviewer commits only if all of these hold:
> - `bun run coverage:diff --base 6171c87` shows no lost lines;
> - `bun run mutate tests/mutations/<cluster>.ts` shows 0 regressions;
> - the keep-list below is still present;
> - each deletion and its replacement are in the same diff.
>
> **Mutation manifests**
> - Format: `export const manifest = { … } satisfies MutationManifest` (import the type from `./types.js`; copy the shape of `tests/mutations/guards.ts`).
> - `old_tests` = the files at the worktree base. `new_tests` = the files after your change.
> - Each `find` matches **exactly once** and must typecheck after replacement.
> - **Every mutant must bite:** it changes behaviour on a path your new tests drive. No equivalent mutants. Known equivalent: drizzle `desc(sql\`rowid\`)` removal while `idx_store_created` exists. The reviewer drops anything that survives on both sides.
>
> **Model-based testing**
> - Use `testing.law.provider_equivalence` + `testing.law.equivalence_command<Model, S, R>`. Copy the structure of `tests/property/backend-equivalence.test.ts`.
> - Fresh model and fresh SUT per run; `build` must not capture state across runs.
> - Command payloads are plain `fc.*` (**never** `testing.compose`: its `fc.gen()` shrinker hangs). Use `size: "max"`.
> - Dates are clamped to 2000-2100. Use `fc.stringMatching`, never `fc.hexaString`.
> - Never loosen the model to make a backend pass. A divergence is a **finding**: report the minimal counterexample, and the reviewer decides on a lib fix as its own commit.
>
> **Imports**
> - Use in-repo source (`../../testing/index.js`, `../../testing/laws/index.js`, `../../backend/*.js`, `../fakes/*.js`, `../support/tmp.js`).
> - Tests import root `zod`. `z.record` always takes two arguments.
>
> **Typed-ESLint traps (you cannot run lint)**
> - `restrict-template-expressions`: wrap non-strings in template literals (labels, test names) with `String(x)`.
> - `no-confusing-void-expression`: arrow bodies that return void need braces.
> - `must-use-result` is relaxed in `tests/**`, but still check `.ok` before reading `.value`/`.error`.
> - Use `toSorted`/`toReversed`, never `sort`/`reverse`.
> - `consistent-function-scoping`: helpers that capture nothing go at module level.
> - No non-null `!`. Narrow with `if (!x) throw new Error(…)`.
> - No `any`, as few `as` casts as possible, no `mock`/`spyOn`.
> - `await` every promise, including `expect(...).rejects`.
> - Relative imports end in `.js`. snake_case identifiers, kebab-case file names.
> - `@ts-expect-error` must be on the line directly above the offending expression.
>
> **Hands off:** `AGENTS.md`, `eslint.config.ts`, `package.json`. Citation updates happen once at phase close.
>
> **Skills:** `pipelines-setup`, `corpus-patterns`, `testing-strategy`.
>
> End your report with **Reviewer deletions** (paths or "none"), **Divergences found** (or "none"), then `## Process feedback`.

---

## 3.0 (C8a): caller-supplied observation id; layered fan-out with one shared id

**Worktree:** `p3-layered-obs`. **This is the only lib change in Phase 3, and it is a PUBLIC API ADDITION.** It needs a release-notes entry and a **minor** bump at the next release (not part of this PR).

**Decision Q7 = option A (user, 2026-11-24).**

**Bug being fixed** (verified at `8d9b35c`). `create_layered_observations_client` (`backend/layered.ts` ≈ 234-302) fans `put` out to every write layer, and each layer mints its own id. The client returns the **last** layer's observation, while reads come from the **first** read layer. With `read: [cache, disk], write: [cache, disk]`:
- `put` → `get(id)` gives `observation_not_found`;
- `delete(id)` returns ok but leaves the cache row.

**Behaviour today when an id repeats** (all must change):
- memory `add_one` does `Map.set`, which **silently overwrites**;
- file `add_one` does `rows.push`, which creates **a duplicate row**;
- drizzle inserts hit a PK conflict and surface as a generic `storage_error`.

`tx.observe` (`corpus.ts` ≈ 571-600) feeds `apply_batch`'s `observation_put` op:
- memory `apply_batch` overwrites silently;
- file `apply_batch` concatenates (`backend/file.ts` ≈ 442-472);
- cloudflare's batch aborts on the PK conflict.

### Scope

**1. Public type.** Add to `ObservationPutOpts<T>` (`observations/types.ts` 123):

```ts
/**
 * Caller-chosen id. Omit to have one generated. Must match `observation_id_schema`.
 * A put whose id already exists fails with `validation_error`; it never overwrites.
 */
id?: string;
```

`ObservationPutOpts` is the single source of the shape, and `tx.observe` already takes it.

**2. Format rule (single source of truth).**
- In `observations/utils.ts`, export `observation_id_schema = z.string().regex(/^obs_[A-Za-z0-9_-]{1,64}$/)` (`zod/v4`, the library convention).
- `generate_observation_id()`'s output must satisfy it. Add a one-line test.
- Re-export it next to `generate_observation_id` wherever that is exported. Grep `observations/index.ts` and `index.ts`, and if `generate_observation_id` isn't public, export both from `observations/index.ts`.
- Why the prefix is required: it keeps the existing "ids start with `obs_`" invariant true for caller ids, bounds the length, and is safe in file JSON and SQL params.

**3. Client put** (`observations/client.ts` ≈ 140):
- `const id = opts.id ?? generate_observation_id()`.
- A supplied id that fails `observation_id_schema.safeParse` gives `err({ kind: "validation_error", message: \`invalid observation id "${id}"\`, cause })`, **before** any storage call.
- Do the same in `tx.observe` (`corpus.ts` ≈ 571).

**4. Collision gives `validation_error`, never an overwrite.**
- **Error kind:** `{ kind: "validation_error", message: \`observation id "${id}" already exists\`, cause: new Error(...) }`. It is deliberately **not** a new `CorpusError` variant: per AGENTS.md, adding a kind breaks every consumer's exhaustive switch and `error_path_exhaustive` provoke table, which would make this a major bump.
- **Placement:** each backend's **atomic section** owns the check, so it can't race:
  - **memory** `add_one` (`backend/memory.ts` ≈ 216): if `observation_store.has(row.id)`, return the err (synchronous check-then-set, no `await` in between). The `ObservationsAdapter.add_one` return type already allows a Result (`observations/storage.ts` 196/210).
  - **file** `add_one` (`backend/file.ts` ≈ 324): inside the existing `locked([OBS_LOCK], …)` block, check `rows.some((r) => r.id === row.id)` before the `push`.
  - **drizzle** `put_row` (`backend/drizzle-storage.ts` ≈ 287): keep relying on the PK. Map the insert failure whose message contains `UNIQUE constraint failed` and `corpus_observations.id` to the collision `validation_error`; every other failure stays `storage_error`. The message must come through both the bun:sqlite fake and the D1 HTTP `/raw` envelope (`remote-d1.ts` throws with the D1 error text). Assert it on cloudflare **and** remote.
  - **`apply_batch`** (tx path):
    - memory: before applying, reject an `observation_put` whose id exists or repeats within the batch, by throwing inside the existing try → rollback → `transaction_aborted`;
    - file: the same check during staging, before any rename;
    - cloudflare: the PK conflict already aborts the batch.
    - Result for all three: `transaction_aborted` with **no writes visible**.
  - **`remote`** has no `apply_batch` (sequential fallback). Its `put_row` collision maps to `validation_error` like drizzle, and the fallback's compensation runs.

**5. Layered put** (`backend/layered.ts`):
- `const id = opts.id ?? generate_observation_id()` (import it from `../observations/utils.js`, which is a runtime import; it's pure).
- For each write layer, call `put(type, { ...opts, id })` in order.
- On a failure at layer k > 0, best-effort `delete(id)` on layers 0..k-1, then return the failing result. If the failure is a collision at layer 0, nothing is written.
- Return the **first write layer's** observation. Every layer now stores the same id; `created_at` may differ by ≤ a few ms across layers, and reads report the primary read layer's value. Document that in the function comment.

**6. Layered delete / get / query / is_stale**
- `get`, `query`, `query_meta` and `is_stale` are unchanged: they read from the primary read layer, which is now consistent because every write layer holds the same id.
- **`delete(id)`:** fan out to all write layers.
  - ok if at least one layer deleted it and every other layer returned ok or `observation_not_found`;
  - `observation_not_found` only if **no** layer had it;
  - any other error propagates (today the code keeps only the last layer's result).
- **`delete_by_source`:** today it **sums** counts across layers, which double-counts replicated rows, and it **swallows** errors (`if (result.ok)`).
  - Return the **bottom write layer's** count, the source of truth.
  - Still delete from every layer.
  - Propagate the first error.

**7. Docs**
- `docs/src/content/docs/guides/observations.mdx`: a short "Choosing an id" subsection (optional `id`, format, collision gives `validation_error`, idempotent-retry pattern: retrying a put with the same id fails loudly rather than duplicating).
- Run `bun run docs:build` (the reviewer does) so `llms.txt` regenerates.

**8. AGENTS.md** (the one exception to the hands-off rule, because this task changes lib semantics). Add one Gotchas bullet: "`ObservationPutOpts.id?` (0.10.0): caller ids must match `observation_id_schema`; a repeated id is `validation_error` (never an overwrite) on every backend, enforced in each adapter's atomic section; in-tx collisions give `transaction_aborted`. Layered put generates the id once and fans it to every write layer; `delete_by_source` reports the bottom layer's count."

### Tests

All new or edited:
- **`tests/integration/layered-backend.test.ts`**, new `describe("observations")` with `read: [cache, disk], write: [cache, disk]` (two memory backends):
  - the probe cases: `put` → `get(id)` is ok and has the same id on **both** layers (`cache.observations.get(id)` and `disk.observations.get(id)` are both ok);
  - `delete(id)` removes it from **both** layers, and `query()` yields 0;
  - `delete_by_source` returns the real count (not 2×);
  - a caller-supplied `id` is honoured on both layers;
  - a collision at layer 1 (pre-seed `disk` with the same id) leaves layer 0 clean and returns `validation_error`.
- **`tests/integration/observations-id.test.ts`** (new), with a 3-backend loop over memory, file and cloudflare plus remote via the HTTP fakes (start, stop):
  - a valid caller id round-trips;
  - malformed ids give `validation_error` with **no row written** (table: `""`, `"abc"`, `"obs_"`, `"obs_has space"`, 65+ chars);
  - a second put with the same id gives the collision `validation_error`, and the **original row is unchanged** (content equal);
  - `tx.observe` with a colliding id gives `transaction_aborted` and the tx's other writes are not visible (memory, file, cloudflare; remote takes the fallback path, so assert it returns an error and the original row is unchanged);
  - `generate_observation_id()` satisfies `observation_id_schema` (100 samples).
- **`tests/mutations/guards.ts`**, new guards:

| Guard id | Mutation | Test file to add to `old_tests`/`new_tests` |
|---|---|---|
| `guards/layered-observations-shared-id` | layered `put` passes `opts` instead of `{ ...opts, id }` | `layered-backend.test.ts` |
| `guards/observation-id-collision-memory` | remove the memory `add_one` `has` check | `observations-id.test.ts` |
| `guards/observation-id-collision-file` | remove the file `add_one` `some` check | `observations-id.test.ts` |

  The 3.1 coder later points these at the contract if the tests move. They stay in `layered-backend` and `observations-id` for now.

### Keep / Tripwires

- Keep everything else in `layered-backend.test.ts`. 3.4 trims list merging later in a different worktree; your `describe` is additive.
- **Never** echo the whole opts object in error messages. The id only.
- `observations/storage.ts` JS filters and ordering are unchanged.
- No `as` to force the adapter Result.
- `@ts-expect-error` is not needed; `id` is optional.
- The drizzle UNIQUE mapping must match on the column (`corpus_observations.id`), not on any UNIQUE failure.
- Layered compensation is best-effort: ignore and don't surface delete errors during rollback, but always return the original failure.
- Known remaining asymmetry, **out of scope**: layered `apply_batch` (tx) still writes only the bottom layer (existing AGENTS gotcha), so tx observations aren't in the cache layer. Mention it in the function comment and don't fix it.

**Reviewer deletions:** none.
**Release note** (reviewer records it in the PR body): "Added optional `ObservationPutOpts.id` (caller-chosen observation ids, validated; collisions are rejected with `validation_error` on every backend). Fixed the layered backend's observation fan-out (ids now agree across layers; `delete` and `delete_by_source` are consistent). Minor bump."

---

## 3.F (C8b): `reset()` hooks on the HTTP fakes

**Worktree:** `p3-fake-reset`.

**Files:** `tests/fakes/d1-http.ts`, `tests/fakes/s3.ts`, `tests/integration/http-fakes.test.ts`.

**Scope**
- **`create_fake_d1_http`:**
  - Change `const fake_d1` to `let fake_d1`.
  - Add `reset: () => void` to `FakeD1HttpServer`. It closes the old `fake_d1.sqlite` and rebuilds with `create_fake_d1(tables)`.
  - The server's fetch handler must read the **current** `fake_d1` at request time, not a captured one.
  - The exposed `sqlite` becomes a getter (`get sqlite() { return fake_d1.sqlite; }`) so existing callers keep working.
- **`create_fake_s3`:** add `reset: () => void` to `FakeS3Server`, which clears the `objects` map.
- **`http-fakes.test.ts`:** add one test per fake. Write state, `reset()`, then assert the state is gone and the server still serves: a D1 query after reset hits a fresh schema; S3 GET after reset is 404 `NoSuchKey`.

**Mutations:** none (test-fake change; no lib code). The reviewer runs the gate only.

**Tripwires**
- Don't change any existing fake behaviour or quirk: 200 + `success:false`, 401, `NoSuchKey`.
- Don't introduce `stop()` in `reset()`.

**Reviewer deletions:** none.

---

## 3.1 (C8): observations contract suite and observations equivalence model

**Worktree:** `p3-observations` (from the post-Wave-0 tip).

**Files**
- New `tests/integration/observations-contract.test.ts`.
- New `tests/property/observations-equivalence.test.ts`.
- New `tests/mutations/observations.ts`.
- Edit `tests/mutations/guards.ts`: repoint its `tests/integration/observations-entity.test.ts` entries to `tests/integration/observations-contract.test.ts`.

### A. `run_observations_contract_tests(name, factory, cleanup?)`

Export it from the contract file, mirroring `run_backend_contract_tests`. The factory signature is `(on_event?: EventHandler) => Backend | Promise<Backend>`, so event assertions can wire a sink (`create_memory_backend({ on_event })` exists; check each backend's config for an `on_event` field and thread it in).

Invoke it for:
- `memory`;
- `file` (`make_tmp_dir` per factory, cleanup removes it);
- `layered` (`read: [cache, disk], write: [cache, disk]`; memory cache over file disk);
- `cloudflare` (fresh `create_fake_d1([corpus_snapshots, corpus_observations])` + `create_fake_r2()`);
- `remote`: one `create_fake_d1_http` + `create_fake_s3` pair per file, started in `beforeAll`, `stop()`ped in `afterAll`; the factory calls `reset()` on both and returns a fresh `create_remote_backend(...)`. Copy the config shape from `backend-contract.test.ts` ≈ 995.

Contract content (examples the model can't express: validation, events, wall-clock timestamps, ids, edge guards):

| Area | Tests |
|---|---|
| CRUD edges | `get` of a missing id is `observation_not_found`; `delete` of a missing id is `observation_not_found` |
| Type validation | one table: missing field, wrong type, out of range, below minimum, bad enum (each rejected), plus one valid enum accepted |
| Optional fields | confidence, observed_at, derived_from, source path, span, path+span round-trip; omitted optionals stay absent |
| Timestamps | `created_at` is set automatically and preserved on `get`; it differs from `observed_at`; `created_after` and `created_before` filters, using wall-clock bounds taken around the puts |
| Ids | ids are unique and start with `obs_` |
| Unknown query key | yields nothing and emits exactly one `validation_error` event; keep the `@ts-expect-error` |
| Content | complex nested content and special characters round-trip |
| **Entity guards (keep verbatim)** | inherits `entity_key` from the source; explicit key overrides; unkeyed source stores no key and omits it on round-trip; put succeeds with no key when the source is missing; query filters by `entity_key` **before limit** with interleaved entities; `query_meta` carries `entity_key`; is_stale: another entity's snapshot does not stale a keyed pointer (**#57 item 4**), a newer same-entity snapshot does, unkeyed pointers use the store-wide rule, a missing source falls back to the store-wide rule |
| **version_filter guards (keep verbatim)** | Set / array / function filters each apply **before limit**; empty Set and empty array yield nothing |
| **exclude_source_version guard** | combined with `source_store`, `limit: 1` returns the newest previous observation |
| File only | `describe("file persistence")` with "persists observations across backend instances" and "persists multiple observations" |

Also move verbatim into this file as plain `describe`s (they are storage-level, not per-backend): `observations-exclude-version.test.ts`'s `same-ms ordering - JS adapters` (3 tests) and `same-ms ordering - drizzle` (1 test).

### B. Observations equivalence model (`tests/property/observations-equivalence.test.ts`)

**Providers:** the same five as in A. Layered uses two layers; with 3.0 applied it agrees with the model. Remote uses one shared transport per file with `reset()` in `build`.

**SUT type** `S = { backend: Backend; ids: string[] }`. Ids are minted by each backend, so commands refer to observations by **ordinal**:
- `put` pushes the returned id;
- `get` / `delete` take `ordinal % ids.length` and treat an empty list as a no-op that yields the `observation_not_found` shape.

The model mirrors this with its own ordinal list. This is the core design point; without it the model can't compare `get`/`delete`.

**Model:** an insertion-ordered row list plus a snapshot-meta `Map` (keyed `store:version`, so insertion order follows `Map` semantics) for `is_stale` and entity inheritance.

**Pools:** stores `["pages", "docs"]`, versions `v1..v4`, paths `[undefined, "$.a", "$.b"]`, two observation types, pooled `observed_at` dates, optional `entity_key ∈ {undefined, "e1", "e2"}`.

**Commands**
- **`put_snapshot(store, version, entity_key?, created_at pooled)`:** `backend.metadata.put`.
- **`put_observation(type, source, content, entity_key?, observed_at?, confidence?)`:** entity inheritance from the source snapshot, as in `observations/client.ts` `put`.
- **`get(ordinal)`.**
- **`delete(ordinal)`.**
- **`delete_by_source(pointer with optional path)`:** returns a count. Read `observations/storage.ts` for whether path is a filter or must match exactly.
- **`query(filters)` / `query_meta(filters)`:**
  - Filters are a generated subset of `type` (string | string[]), `source_store`, `source_version`, `exclude_source_version`, `source_prefix`, `after` / `before` (observed_at), `entity_key`, `version_filter` (Set | array | sync fn | async fn over a generated version subset; read `VersionFilter` in `observations/types.ts` for the function arity) and `limit`.
  - Compare **in order**. Expected order = newest `created_at` first, ties broken by later insertion first. Within one run, `created_at` is non-decreasing with insertion, so the expected order is the **reverse insertion order of surviving rows**.
  - **Exclude `created_after`/`created_before`** (wall clock; covered in A).
- **`is_stale(ordinal)`:** mirror `observations/client.ts` `is_stale` (≈ 206-216) exactly, including the keyed vs store-wide rule and `get_latest`'s insertion tie-break.

**Normalisation:** compare observations without `id` and `created_at` (wall clock). Dates become epoch ms. `undefined` keys count as absent (reuse the `deep_equal` style from backend-equivalence).

**Budget:** `numRuns: 200`, `maxCommands: 30`, `size: "max"`, a wall-clock budget assertion like backend-equivalence's, and a per-command-type ≥3% share floor.

### Reviewer deletions

| Path | Its unique assertions now live in |
|---|---|
| `tests/integration/observations-memory.test.ts` | A (contract) / B (model) |
| `tests/integration/observations-file.test.ts` | A (contract) / B (model) |
| `tests/integration/observations-entity.test.ts` | A (contract) |
| `tests/integration/observations-version-filter.test.ts` | A (contract) |
| `tests/integration/observations-exclude-version.test.ts` | A (contract) + same-ms describes |

Keep `tests/integration/observations-transactions.test.ts`.

### Replaced by the model (do not re-create as examples)

From the memory/file suites:
- **basic CRUD:** puts and gets, deletes, `delete_by_source` (removes / returns 0 / respects path);
- **query filtering:** type, multiple types, source_store, source_version, source_prefix, observed_at after / before / both, limit, limit 2, `query_meta` excludes content, `query_meta` respects filters, combined filters, empty for non-matching;
- **staleness detection:** 3 tests;
- **version_filter:** Set / string[] / sync fn / async fn / excludes non-matching / returns all with no filter / `query_meta` with Set or fn / fn receives store_id;
- **query ordering:** "created_at descending".

### Mutations (≥8, each bites a model or contract path)

1. `backend/drizzle-storage.ts` `delete_by_source` ignores the path condition.
2. `backend/drizzle-storage.ts` `delete_by_source` returns 0 instead of the affected count.
3. `backend/drizzle-storage.ts`: the `source_prefix` condition uses `eq` instead of a prefix match (read ≈ 315-340 for the real filter code).
4. `backend/drizzle-storage.ts`: drop the `exclude_source_version` condition.
5. `observations/storage.ts`: the JS filter pipeline drops the `type` array membership check.
6. `observations/storage.ts`: the observed_at `before` comparison is inverted.
7. `observations/client.ts`: `is_stale` ignores `entity_key` (always takes the store-wide rule).
8. `observations/client.ts`: the function `version_filter` stops early **before** applying `limit` (read `filtered_rows`).
9. `observations/client.ts`: `put` no longer inherits `entity_key` from the source.
10. `backend/layered.ts` (post-3.0): `delete_by_source` returns the summed count across layers instead of the bottom layer's.

### Keep-list

Every row marked **keep verbatim** in table A; the two file-persistence tests; the same-ms ordering describes; `observations-transactions.test.ts`.

### Tripwires

- **Layered without 3.0** diverges on put→get. If your worktree somehow lacks 3.0, report it; don't work around it.
- The remote fake pair must be `stop()`ped in `afterAll`; `reset()` happens in `build`/factory only.
- Several `observations-memory` tests (`rejects unknown query keys`) use `@ts-expect-error`. Keep them as type-level guards.
- `guards.ts` must still list a file that kills `guards/observations-drops-entity-filter`: your contract's "filters by entity_key before limit".

---

## 3.2 (C9): backend-equivalence expansion

**Worktree:** `p3-backend-model` (from the post-Wave-0 tip).

**Files:** edit `tests/property/backend-equivalence.test.ts`; new `tests/mutations/backend-model.ts`.

### Scope

**1. Metadata arbitrary**
- Add `entity_key: fc.option(fc.constantFrom("e1", "e2"), { nil: undefined })` to `meta_arb`, and to `norm_meta` (absent when unset).
- Draw `created_at` from a **pool of 4 fixed dates**, so ties happen and `before`/`after` boundaries are hit.

**2. Store ids:** add the prefix collider and the wildcard case: `STORE_IDS = ["alpha", "alp", "beta", "a_b", "axb"]`. The data-key pools must stay `<store>/<hex>` with **no `_`** in the key, because of the file-backend aliasing guard. So `a_b`'s data keys are `ab/<hex>`, or use only the existing keys; `data_key` is independent of `store_id`.

**3. New commands** (`equivalence_command`, plain `fc.*` payloads):

| Command | Model semantics |
|---|---|
| `list_meta_filtered(store, {limit?, tags?, before?, after?, entity_key?})` | Filter by tags (AND), dates and `entity_key` (exact; unkeyed never matches), then sort newest `created_at` first with the insertion tie-break (later first), then apply `limit`. **Compare in order.** Read `utils.ts` `filter_snapshots`/`create_filter_pipeline` for whether `before`/`after` are inclusive or exclusive, and mirror it exactly. |
| `get_latest(store, entity_key?)` | Newest `created_at`, insertion tie-break (later put wins), entity-scoped if given; empty set gives `not_found`. |
| `get_children(store, version)` | Metas whose `parents` include `{store, version}`; compare canonical-sorted. |
| `find_by_hash(store, hash)` | **Normalise** to `{ found: boolean; store_id?; content_hash? }`. Backends may return *any* matching version, so never compare the version. Draw `hash` from the hashes the generated metas use (a small pool, e.g. 3 values). |
| `list_stores()` | Distinct `store_id`s of the remaining metas, sorted. |

**4. Insertion-order model:** derive order from the model's `Map` iteration (`m.meta`). Re-putting an existing `store:version` keeps its original position, matching `Map.set`, the memory backend and drizzle's `onConflictDoUpdate` rowid. Never keep a separate counter.

**5. Switch `list_meta` to an ordered comparison.** Drop `canonical` for list commands.

**6. New providers** (all at `numRuns: 200`, decision Q1(b)):
- **`cloudflare`:** `build: () => create_cloudflare_backend({ d1: create_fake_d1([corpus_snapshots, corpus_observations]), r2: create_fake_r2() })`.
- **`remote`:**
  - one `create_fake_d1_http([...])` + `create_fake_s3()` pair started in `beforeAll` and `stop()`ped in `afterAll`;
  - `build` calls `d1.reset(); s3.reset();` and returns a fresh `create_remote_backend({...})`;
  - copy the config shape from `backend-contract.test.ts` ≈ 995.
- **`wrapped-bytes`:** `{ ...create_memory_backend(), data: create_data_client(wrap_bytes_storage(map_storage), () => {}) }`.
  - `map_storage` is a module-level factory that returns a fresh `BytesStorage` over a `Map` per call.
  - `wrap_bytes_storage` and `create_data_client` come from `backend/base.ts`.
  - This covers `base.ts` 67-90.

**7. Budget and floors**
- Keep the `< 30_000` ms assertion.
- Replace the ≥5% per-type floor with ≥3% over the new 13 types, and keep the `ALL_COMMAND_TYPES` list in sync.
- Recompute the total-volume floor for 6 providers and say how in a comment.

**8.** Update the header comment: cloudflare/remote are no longer excluded; document the shared transport plus reset.

### Mutations (≥8; old = this file at base, new = this file after)

1. `backend/drizzle-storage.ts` list `store_id`: `eq(` → `like(`. The prefix/wildcard pools now kill it here too.
2. `backend/drizzle-storage.ts` list: drop the tags `EXISTS` condition.
3. `backend/drizzle-storage.ts` list: drop the `entity_key` condition.
4. `backend/drizzle-storage.ts` get_latest: drop the `entity_key` condition.
5. `backend/memory.ts` or `backend/base.ts` (wherever HEAD's insertion tie-break lives): `>=` → `>`.
6. `utils.ts` filter pipeline: `before` boundary flipped (`<` ↔ `<=`, matching the real code).
7. `utils.ts` filter pipeline: `limit` applied before the tag filter (or `limit` ignored).
8. `backend/drizzle-storage.ts` `list_stores` (`selectDistinct`): remove the ORDER BY (only if HEAD sorts in SQL; otherwise the JS sort site).
9. `backend/drizzle-storage.ts` `get_children`: drop the parent-version match.
10. `backend/base.ts` `wrap_bytes_storage`: `exists` → always `false`, or `get` returning `null` for an empty array.
11. `backend/drizzle-storage.ts` `find_by_hash`: drop the `store_id` condition.

### Keep-list

The existing 8 commands and their semantics, the fresh-SUT-per-run protocol, the budget assertion.

### Tripwires

- **`list_stores` after deletes.** The memory and drizzle backends derive it from rows. The file backend walks directories and may list a store whose metas were all deleted. If that diverges, **report it as a finding** (counterexample plus file path). Don't filter empty stores out of the SUT arm.
- `find_by_hash` is "any version": compare only presence and the store/hash identity.
- The remote `build` must `reset()` **before** constructing the backend, and must never `stop()` the servers.
- The `bump`/volume counters must not run inside `build`.

**Reviewer deletions:** none.

---

## 3.3 (C10): prune backend-contract; delete `remote-r2.test.ts`

**Worktree:** `p3-contract-prune`, branched from the tip **after C9 is committed**. Dispatch only after 3.2 is committed.

**Files:** edit `tests/integration/backend-contract.test.ts`; new `tests/mutations/backend-contract.ts`.

### Plan correction (Q4)

The planned "fold `handle.size` into the contract data-handle block" is **impossible**:
- the public `DataHandle` (`types.ts` 216) has only `stream` and `bytes`;
- `DataStorageHandle.size` (`backend/base.ts` 39, optional) is set by memory, file, remote-r2 and `wrap_bytes_storage` but **read by no library code**.

So `remote-r2.test.ts`'s size test guards an unobservable field. Its other 7 tests (round-trip, null on missing, exists true/false, delete, delete idempotent, stream) re-assert the DataStorage contract that the RemoteBackend contract run and the C9 model already cover. **Delete the file** and add no `size` assertion. The dead `size` field is recorded as an out-of-scope follow-up.

### Prune

Delete these `it`s inside `run_backend_contract_tests`. They are now model-checked on all 6 providers by C9:
- **metadata get:** "returns not_found for missing version", "retrieves stored metadata".
- **metadata put:** "stores metadata successfully", "allows storing multiple versions", "overwrites an existing version on repeated put", "preserves all metadata fields on roundtrip".
- **metadata delete:** "removes stored metadata", "succeeds when deleting non-existent metadata".
- **list:** "returns empty for store with no versions", "returns all versions for a store", "only returns versions from requested store", "respects limit option", "filters by tags when provided", "applies tag, date and limit filters together".
- **get_latest:** "returns not_found for empty store", "returns newest by created_at".
- **entity_key:** "get_latest for an unknown entity is not_found", "store-wide get_latest is unchanged by keyed snapshots", "list filters by entity_key and unkeyed rows never match", "combines entity_key with tags".
- **get_children:** both. **find_by_hash:** all 3. **list_stores:** "yields each store id exactly once".
- **data get:** both. **data put:** "stores bytes successfully", "preserves binary data exactly". **data delete:** both. **data exists:** both.

Remove any helper or `describe` left empty, and any now-unused imports.

### Keep-list (named guards and non-model behaviour)

- **list:** "matches store_id exactly, not as a prefix", "treats LIKE wildcards in store_id literally", "applies tag filters before limit".
- **get_latest:** "breaks created_at ties by insertion order (later put wins)", "store-level get_latest is always the last put, even within one millisecond".
- **entity_key:** "round-trips entity_key and omits the key when unset" (an `undefined`-vs-absent guard the model's `deep_equal` can't see), "get_latest per entity follows insertion order on created_at ties", "applies the entity filter before limit", "store.put persists entity_key and store.get_latest scopes by it".
- **data put:** "accepts ReadableStream input".
- **Whole blocks:** data handle, streaming reads, cross-client consistency, transaction contract, and the "backend-specific streaming chunk counts" describe.
- **Every registration:** all 6 `run_backend_contract_tests(...)` calls stay.

### Mutations (≥8)

- **`old_tests`:** `tests/integration/backend-contract.test.ts`, `tests/unit/remote-r2.test.ts`, `tests/property/backend-equivalence.test.ts`.
- **`new_tests`:** the pruned contract plus `backend-equivalence`.
- **Rule:** every mutation must target a code path one of the **pruned** tests exercised.

1. `backend/memory.ts` metadata `delete` is a no-op.
2. `backend/file.ts` metadata `put` drops `tags` when persisting (or another field the "preserves all fields" test checked).
3. `backend/drizzle-storage.ts` metadata `get` returns `not_found` when the row exists but `invoked_at` is set (or the real row-to-meta field mapping, e.g. `parents` parse).
4. `backend/drizzle-storage.ts` list `limit` ignored.
5. `backend/remote-r2.ts` `exists` inverted.
6. `backend/remote-r2.ts` `get` of a missing key: return a handle instead of `null`.
7. `backend/remote-r2.ts` `delete` throws on a missing key (if HEAD swallows `NoSuchKey`, flip that).
8. `backend/cloudflare.ts` R2 `exists` (or `delete`) adapter inverted.
9. `backend/file.ts` `find_by_hash` searches all stores.

**Reviewer deletions:** `tests/unit/remote-r2.test.ts`.

### Tripwires

- The 84 contract-unique lines (backend-specific error/emit branches) must still be covered, and `coverage:diff` proves it. If a pruned test was the only path to an emit or error branch, keep it and say why.
- `guards.ts` references `backend-contract.test.ts` and needs no edit. Its guards (`list-store-id-like-not-eq`, `list-drops-tag-filter`, `list-drops-entity-filter`, `get-latest-drops-entity-filter`, `memory-latest-strict-gt`) must stay killed by kept tests.

---

## 3.4 (C11): memory/layered store-level duplicates

**Worktree:** `p3-store-level` (from the post-Wave-0 tip, so 3.0's layered observations `describe` is present).

**Files:** edit `tests/integration/memory-backend.test.ts` and `tests/integration/layered-backend.test.ts`; new `tests/mutations/store-level.ts`.

### memory-backend.test.ts (corpus store API on memory)

**Delete** (contract or model duplicates):
- **basic crud:** "returns not_found for missing version", "deletes a snapshot", "returns not_found when deleting non-existent", "get_latest returns most recent by created_at", "get_latest returns not_found on empty store", "list returns all snapshots newest first".
- **tags and filtering:** "filters list by tags", "filters list by multiple tags using AND logic", "filters list with limit", "filters list by before date".
- **multiple stores:** all 3.
- **lineage:** "get_children returns snapshots with matching parent".
- **invoked_at:** "preserves invoked_at on get".

**Keep:**
- **basic crud:** "puts and gets a snapshot", "get_meta returns only metadata without data".
- **deduplication:** all 3, including the event.
- **lineage:** "stores parents on put", "preserves parents on get", "supports multiple parents".
- **tags:** "stores tags on put".
- **event observability:** all 5 (unique `corpus.ts` 308-314).
- **invoked_at:** "stores invoked_at timestamp".

### layered-backend.test.ts

- Replace `describe("list merging")`'s "merges results…", "deduplicates by version", "sorts by created_at descending" and "applies limit after merging" with **one property**:
  - Inputs: two memory read layers with generated metas (pooled versions and dates, overlaps across layers) and an optional limit.
  - Assertion: layered `list(store, {limit})` equals the union deduped by version (**first read layer wins** on duplicates), sorted newest `created_at` first with ties as in `backend/layered.ts`, with `limit` applied **after** the merge.
  - Read `backend/layered.ts` list (≈ 90-130) and mirror its exact tie rule. If it's ambiguous, report it.
- Keep "uses first strategy when configured" and everything else, including 3.0's `describe("observations")`.

### Mutations (≥6)

1. `backend/layered.ts` list: dedupe keeps the **last** layer's copy.
2. `backend/layered.ts` list: no dedupe.
3. `backend/layered.ts` list: ascending sort.
4. `backend/layered.ts` list: `limit` applied per layer before the merge.
5. `corpus.ts` store `get_meta` returns via the data path, or skips `metadata.get` (pick the real code).
6. `corpus.ts` put dedup: `find_by_hash` result ignored, so a new `data_key` every time.
7. `corpus.ts` `list` emits no `meta_list` event (≈ 308-314).
8. `corpus.ts` put drops `parents` from the stored meta.

**Reviewer deletions:** none (edits only).

### Tripwires

- The layered list property uses plain `fc.*` and builds fresh memory layers per run.
- `layered.ts` 102-105 must stay covered.
- Don't touch 3.0's observations tests.
