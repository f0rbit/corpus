# Cross-store atomic put

Status: Proposal — no code written.
Owner area: `corpus.ts`, `backend/*`, `observations/*`, `tests/integration/*`.
Estimated total LOC: ~1100 production + ~600 tests, spread across 6 phases.

---

## 1. Background & motivation

Today consumers compose snapshots into related stores by issuing independent `store.put()` calls. There is no way to roll back a successful first put if a later put fails. Two real cases motivate this:

1. **Timeline + index** — a user maintains a `timeline` store of immutable events and a `timeline_index` store that pre-aggregates per-day rollups. After ingesting a new event, the consumer wants both stores to advance together. If the index put fails after the timeline put succeeds, the index lags silently and downstream readers see inconsistent state.
2. **Snapshot + observation** — an extractor writes a `documents` snapshot, then immediately records an `observation` (e.g. `entity_mention`) pointing at that snapshot. Today the observation can land while the snapshot put fails on retry, leaving an observation whose `source` resolves to `not_found`.

Both cases want the same primitive: *N writes commit together or none commit*.

corpus is a thin library — we are not building a distributed transaction manager. The goal is to give consumers a single API that backends honour as best they can, and to be honest about each backend's actual guarantees.

---

## 2. API design

Three options, picked one.

### Picked: callback pattern

```ts
const result = await corpus.transaction(async (tx) => {
  const event = await tx.put(corpus.stores.timeline, payload, { tags: ['evt'] })
  if (!event.ok) return event
  const idx = await tx.put(corpus.stores.timeline_index, build_index(payload), {
    parents: [{ store_id: 'timeline', version: event.value.version, role: 'source' }],
  })
  if (!idx.ok) return idx
  return await tx.observe(entity_type, {
    source: { store_id: 'timeline', version: event.value.version },
    content: { entity: 'climate' },
  })
})

// result: Result<{ commits: SnapshotMeta[]; observations: Observation[] }, CorpusError>
```

Type sketch:

```ts
export type TransactionHandle = {
  put: <T>(store: Store<T>, data: T, opts?: PutOpts) => Promise<Result<SnapshotMeta, CorpusError>>
  observe: <T>(type: ObservationTypeDef<T>, opts: ObservationPutOpts<T>) => Promise<Result<Observation<T>, CorpusError>>
  // read-your-writes within the same tx
  get: <T>(store: Store<T>, version: string) => Promise<Result<Snapshot<T>, CorpusError>>
}

export type TransactionResult = {
  commits: SnapshotMeta[]      // in put-order
  observations: Observation[]  // in observe-order
}

export type Corpus<Stores> = {
  // ...existing fields
  transaction: <R>(
    body: (tx: TransactionHandle) => Promise<Result<R, CorpusError>>
  ) => Promise<Result<{ value: R; commits: SnapshotMeta[]; observations: Observation[] }, CorpusError>>
}
```

### Why callback over the alternatives

| Pattern | Pros | Cons |
|---------|------|------|
| Builder `tx().put(a,v).put(b,v).commit()` | Static type safety per op, easy to inspect | Awkward when later ops depend on earlier results (e.g. need `event.version` to set `parents`); forces consumers to defer all decisions to a planner pass |
| Function `tx([op_a, op_b])` | Trivially serialisable, easy to retry | Same dependency problem; ops must be pre-resolved values, hashing must happen ahead of `tx` |
| **Callback `tx(async tx => …)`** | Matches `db.transaction` ergonomics from Drizzle/Prisma; supports control flow, derived values, branching; backend can buffer ops or stream them | Body can throw — must wrap in `try_catch_async` and translate to `CorpusError`; consumer must remember to return early on `!ok` |

Callback wins because corpus' main use case is *write A, then write B that references A*. Builder/function patterns force a two-pass structure that's worse for the dominant case.

`tx.get` participates in read-your-writes semantics (see §5). Reads of versions written outside the tx still hit the backend directly.

### Surface area

Adds one new exported method on `Corpus`. No changes to `Store<T>` itself — `tx.put(store, data)` lives on the handle, not on the store, so consumers can't accidentally mix transactional and non-transactional puts on the same call site.

---

## 3. Backend interface changes

### Two options considered

**Option A: explicit `begin/commit/rollback`**

```ts
type Backend = {
  metadata: MetadataClient
  data: DataClient
  observations?: ObservationsClient
  on_event?: EventHandler
  // new
  begin?: () => Promise<Result<TransactionContext, CorpusError>>
}

type TransactionContext = {
  metadata: MetadataClient
  data: DataClient
  observations?: ObservationsClient
  commit: () => Promise<Result<void, CorpusError>>
  rollback: () => Promise<Result<void, CorpusError>>
}
```

Consumer code calls `backend.begin()`, gets sub-clients that buffer writes, then `commit()`. Maps cleanly to memory snapshots, file staging dirs, and D1 batches.

**Option B: single `apply_batch(ops)`**

```ts
type BatchOp =
  | { type: 'meta_put'; meta: SnapshotMeta }
  | { type: 'data_put'; data_key: string; bytes: Uint8Array }
  | { type: 'meta_delete'; store_id: string; version: string }
  | { type: 'observation_put'; row: ObservationRow }

type Backend = {
  // ...
  apply_batch?: (ops: BatchOp[]) => Promise<Result<void, CorpusError>>
}
```

The `transaction()` callback runs the body against a buffered handle, collects ops, then submits the batch on commit.

### Picked: Option B (`apply_batch`) — but with a hybrid

`apply_batch` wins because:

1. It's stateless from the backend's perspective. No tx-id bookkeeping, no leaked transaction objects when the body throws, no question of what happens if `commit` is never called.
2. It maps perfectly to D1's `db.batch()`, which is already a "submit a list of prepared statements" API.
3. It composes cleanly with the layered backend — the layered backend just forwards the batch (or splits it per-layer with an opinionated semantics, see §4).
4. Read-your-writes is implemented entirely in the transaction handle layer in `corpus.ts`, not in backends. Backends never see partial state.

The hybrid: the batch handler is **optional**. When `backend.apply_batch === undefined`, `corpus.transaction()` falls back to a **best-effort sequential mode** that:

- Runs each op in order against the live backend.
- On the first failure, attempts a compensating delete for each successful op.
- Returns `Result<R, CorpusError>` with `kind: 'partial_commit'` if any compensation also fails.

This preserves backwards compatibility for any custom `Backend` implementations downstream and surfaces a clear, honest error mode for backends that genuinely can't atomically batch.

### Final shape

```ts
// types.ts
export type BatchOp =
  | { type: 'meta_put'; meta: SnapshotMeta }
  | { type: 'meta_delete'; store_id: string; version: string }
  | { type: 'data_put'; data_key: string; bytes: Uint8Array }
  | { type: 'observation_put'; row: ObservationRow }
  | { type: 'observation_delete'; id: string }

export type Backend = {
  metadata: MetadataClient
  data: DataClient
  observations?: ObservationsClient
  on_event?: EventHandler
  /**
   * Apply ops atomically. If absent, corpus.transaction() falls back to
   * sequential best-effort with compensating deletes.
   */
  apply_batch?: (ops: BatchOp[]) => Promise<Result<void, CorpusError>>
}
```

`apply_batch` is **optional, additive** — no breaking change to any existing `Backend` consumer.

---

## 4. Per-backend implementation strategy

### Memory backend — trivially atomic

```ts
async apply_batch(ops) {
  const meta_snap = new Map(meta_store)
  const data_snap = new Map(data_store)
  const obs_snap  = new Map(observation_store)
  try {
    for (const op of ops) apply_op_inplace(op)  // no awaits inside
    return ok(undefined)
  } catch (cause) {
    meta_store = meta_snap; data_store = data_snap; observation_store = obs_snap
    return err({ kind: 'storage_error', cause: cause as Error, operation: 'apply_batch' })
  }
}
```

Caveat: the snapshot is shallow on the values. SnapshotMeta objects are treated as immutable inside corpus — we never mutate them after they're stored — so a shallow snapshot is sufficient. We will document this invariant.

### File backend — stage-and-rename

```
base_path/
  .tx-<uuid>/
    meta/<store_id>/_meta.json    # full new map for each store touched
    data/<sanitised data_key>.bin
    observations.json             # full new array
  <store_id>/_meta.json           # current state
  _data/...
  _observations.json
```

Algorithm:

1. Generate a tx-id.
2. For each `meta_put`/`meta_delete`, read the current `_meta.json` for that store, mutate the in-memory map, write the new map to `.tx-<id>/meta/<store_id>/_meta.json`. (One write per affected store, not per op.)
3. For each `data_put`, write bytes to `.tx-<id>/data/<sanitised>.bin`.
4. For observation ops, read the current `_observations.json`, apply ops, write the result to `.tx-<id>/observations.json`.
5. Commit phase: for each staged file, `rename()` over the live target. Renames are issued in dependency order (data first, then meta, then observations) to minimise inconsistency windows.
6. Cleanup: remove `.tx-<id>/`.

**Crash-safety caveats — be explicit in docs:**

- Renames are atomic per-file on POSIX (and on NTFS via `MoveFileExW` in Bun's runtime), but **the batch of renames is not atomic across files**. A crash mid-commit can leave some renames applied and others not.
- We mitigate but do not eliminate this: data files are written first (idempotent because content-hashed), then metadata. A crash after data renames but before metadata renames produces orphan blobs, never dangling pointers — this matches the existing non-transactional ordering in `create_store`.
- A crash after a `meta_put` rename but before subsequent `meta_put` renames produces a true partial commit. Recovery: on backend startup, scan for `.tx-*` directories older than N minutes and delete them; we do NOT attempt to roll-forward.
- Open question: do we expose an explicit `recover()` hook on the file backend? See §10.

### Cloudflare backend — D1 batch + R2 best-effort

D1 supports `db.batch([prepared, prepared, ...])` which executes all statements in a single SQLite transaction. R2 has no multi-object atomicity. Strategy:

1. **Phase 1: write all R2 objects.** Each `data_put` is an `r2.put(key, bytes)`. These are content-addressed by hash, so re-runs of the same op are idempotent. We do them sequentially (in op order) so we can short-circuit on the first failure.
2. **Phase 2: build a D1 batch** for every metadata + observation op. Use Drizzle's `.toSQL()` or hand-prepared statements behind `db.batch(...)`. On D1 batch failure, return `storage_error`.
3. **On success**, return `ok(undefined)`.
4. **On D1 failure after R2 puts succeeded**, R2 objects are orphans. We do NOT attempt to delete them — this would race with concurrent writers using the same content hash. Instead, document that orphan R2 objects are expected and provide a separate GC pass (not in scope for this plan; track as a follow-up).
5. **On R2 failure mid-Phase-1**, we abort before D1 entirely — no partial metadata. Already-written R2 objects from this batch remain as orphans.

**Honest guarantees on Cloudflare:**

- All metadata + observations within a single `transaction()` commit atomically (D1 batch is real SQL transaction).
- Data blobs are written before metadata, so any committed metadata always points at a present blob.
- A crash between R2 success and D1 batch results in orphan blobs, never dangling pointers.
- We do NOT provide isolation between concurrent transactions touching the same `(store_id, version)` — D1 batches conflict at the SQLite engine level, last writer wins (or `onConflictDoUpdate` resolves it). Concurrent `transaction()` calls that touch overlapping keys are racy; corpus does not serialise them.

### Layered backend — forward + document semantics

`apply_batch` on the layered backend depends on the role of each layer:

```ts
async apply_batch(ops) {
  for (const layer of write) {
    if (!layer.apply_batch) {
      return err({ kind: 'invalid_config',
        message: 'Layered transaction requires all write layers to support apply_batch' })
    }
    const result = await layer.apply_batch(ops)
    if (!result.ok) return result   // first layer failure aborts; earlier layers already committed
  }
  return ok(undefined)
}
```

**Documented semantics:**

- Each layer commits its own batch atomically.
- Across layers, the layered backend gives **only sequential best-effort** (same as today's sequential put fanout).
- If the cache layer is memory and the persistence layer is file/cloudflare, a layer-2 failure leaves layer-1 with committed state — divergence. This is unavoidable without two-phase commit, which is out of scope.
- Recommendation in docs: use a layered backend for cache/persistence with `read: [cache, persist], write: [persist]` — single-write-layer eliminates the cross-layer atomicity question entirely. If the user wants fanout writes, they accept the tradeoff.

---

## 5. Failure modes & guarantees

State this exactly in the docs:

| Backend | Atomicity | Read-your-writes (in-tx) | Isolation between concurrent tx |
|---------|-----------|--------------------------|---------------------------------|
| Memory | Full (snapshot rollback) | Yes (handle buffers) | None — JS is single-threaded but `await` interleaves; concurrent `transaction()` calls race |
| File | Per-store metadata atomic; cross-store best-effort with crash window | Yes (handle buffers) | None — no file locks |
| Cloudflare | Full atomicity for metadata+observations (D1 batch); R2 orphans on partial failure | Yes (handle buffers) | None — D1 may serialise at the engine level, but corpus does not |
| Layered (single write layer) | Inherits the underlying write layer's guarantees | Yes (handle buffers) | Inherits |
| Layered (multi write layer) | Per-layer atomic; cross-layer best-effort | Yes (handle buffers) | None |

**Read-your-writes implementation.** The transaction handle keeps a buffer:

```ts
type TxBuffer = {
  meta: Map<string, SnapshotMeta>           // key: `${store_id}:${version}`
  data: Map<string, Uint8Array>              // key: data_key
  observations: Map<string, ObservationRow>  // key: id
  ops: BatchOp[]                             // ordered, replayed on commit
}
```

`tx.get()` checks the buffer first, falls back to backend reads. `tx.put()` runs codec encode + hash + dedup lookup against `(buffer + backend)`, appends to `ops`.

**No isolation guarantees.** corpus is intentionally not a transactional database. We do not promise serializability, snapshot isolation, or even read-committed across concurrent `transaction()` calls. Document this.

**No nested transactions.** Calling `corpus.transaction()` inside a transaction body returns `kind: 'invalid_config'`. We can revisit this if a real use case appears.

---

## 6. Backwards compatibility

- `Backend.apply_batch` is **optional**. Existing custom backends compile without changes and fall back to sequential best-effort mode.
- `Corpus.transaction` is **additive** — no existing call sites change.
- `tx.get()` requires the store to exist on the corpus instance, same as today's `corpus.stores.<id>`. No new requirement.
- Built-in backends (`memory`, `file`, `cloudflare`, `layered`) all gain `apply_batch` as part of this work. The fallback path will only ever fire for third-party backends.

**BREAKING:** adding `partial_commit` and `transaction_aborted` kinds to `CorpusError` (see §7) is technically breaking for consumers that exhaustively switch on `error.kind` — TypeScript will force them to handle the new cases. Call this out in release notes.

---

## 7. New CorpusError kinds

Add three:

```ts
export type CorpusError =
  | // ...existing
  | { kind: 'transaction_aborted'; cause: CorpusError; rolled_back: number }
  | { kind: 'partial_commit'; committed: number; failed_at: number; cause: CorpusError; orphans?: string[] }
  | { kind: 'concurrent_modification'; store_id: string; version: string }
```

- `transaction_aborted` — body returned `err()` or threw. `cause` is the original error; `rolled_back` is the number of ops that were successfully undone (always equal to attempted ops on memory; may be smaller on file/cloudflare).
- `partial_commit` — fallback sequential mode could not fully roll back. `orphans` lists data_keys/observation ids that were written but not undone, for GC tooling.
- `concurrent_modification` — only fires if a backend explicitly checks for it (D1 unique constraint conflict surfaces here; memory and file do last-writer-wins and never produce this).

**BREAKING** for any consumer with an exhaustive switch over `CorpusError.kind`. Default `corpus-patterns` users (who treat the error as opaque or pattern-match on a few cases) are unaffected.

---

## 8. Phased implementation

Each phase ends with a verification coder running typecheck + `bun test`, then committing.

### Phase 1 — API surface + types (~170 LOC)

Sequential, single coder. Foundation for everything else.

- Edit `types.ts`:
  - Add `BatchOp` (including `meta_delete`, `observation_delete` from the start — see §10 Q6).
  - Add `TransactionHandle` with `put`, `get`, `delete`, `observe`, `observation_delete` methods.
  - Add `TransactionResult`.
  - Add three new `CorpusError` kinds.
  - Add optional `apply_batch` to `Backend`.
  - Add `transaction` to `Corpus`.
- Edit `corpus.ts`:
  - Implement `transaction()` on the corpus instance. The implementation is backend-agnostic: it builds a buffered handle, runs the body, then either calls `backend.apply_batch(ops)` or falls back to sequential-with-compensation.
  - Detect nested transactions (transaction body invoking `corpus.transaction()` again) → return `err({ kind: 'invalid_config', message: 'nested transactions are not supported' })`.
- New `tx.ts` module (or inlined in `corpus.ts` if it stays small) with:
  - `create_tx_handle(corpus, backend)` — returns `{ handle, get_ops, get_results }`.
  - Buffer + read-through logic.
  - Encode/hash/dedup that consults the buffer.
- Update `index.ts` barrel.

Files touched: `types.ts`, `corpus.ts`, `index.ts`, possibly `tx.ts` (new).
Exit: typecheck passes; existing tests pass; `transaction()` works against memory backend via fallback path; nested transaction returns `invalid_config`.

### Phase 2 — Memory backend `apply_batch` + contract tests (~200 LOC)

Two parallel coders in worktrees. Verification coder merges.

- **Worktree A** — `backend/memory.ts`: implement snapshot-rollback `apply_batch`. ~50 LOC.
- **Worktree B** — `tests/integration/backend-contract.test.ts`: add a `describe('transaction contract')` block covering:
  - atomic success with multiple stores
  - atomic abort: body returns `err()` → no writes visible
  - body throws → translated to `transaction_aborted`, no writes visible
  - read-your-writes: `tx.put` followed by `tx.get` returns the buffered value
  - dedup within tx: two `tx.put` calls with identical content produce one `data_put` op but two `meta_put` ops
  - observations participate (covered properly in Phase 5; stub here)

Exit: contract tests pass for memory backend.

### Phase 3 — File backend (~250 LOC)

Sequential, single coder (uses `coder` not `coder-fast` — file system semantics need careful reasoning).

- `backend/file.ts`: implement staged-rename `apply_batch`.
- Add `recover()` helper exported from `backend/file.ts` that scans for stale `.tx-*` directories.
- Run contract tests against file backend factory in `tests/integration/backend-contract.test.ts`.
- Add a crash-window test that simulates failure between staging and rename (deletes the staging dir mid-flight, asserts no partial state).

Exit: contract tests pass for file backend; crash-recovery test passes.

### Phase 4 — Cloudflare backend (~200 LOC)

Sequential, single coder. Needs Drizzle batch knowledge.

- `backend/cloudflare.ts`: implement `apply_batch` using `db.batch([...])` with prepared statements derived from the existing insert/delete codepaths. Refactor the existing `metadata.put` / `observations.put` to share statement-building helpers with the batch path.
- R2 puts run sequentially before the D1 batch.
- Manual integration test against `wrangler dev` is out-of-band per repo convention. Add a unit-style test using a mock D1/R2 (we already have no D1/R2 in CI, so this is a controlled stub) to verify the order of operations: R2 puts first, then a single `db.batch()` call.

Exit: typecheck passes; ordering test passes.

### Phase 5 — Observations integration (~100 LOC)

Sequential, single coder. Quick.

- Wire `tx.observe()` through to the buffer via an `observation_put` op.
- Update memory and file backends to handle `observation_put` / `observation_delete` ops in their `apply_batch` (cloudflare already covered in Phase 4 since observations use the same D1 batch).
- Layered backend: minimal — already forwards arbitrary ops.
- Extend contract tests with a "snapshot + observation atomic" case: assert that observation rollback happens when a later snapshot put fails.

Exit: all backends honour observations in batches; contract tests pass.

### Phase 6 — Docs (~200 LOC of MDX)

Sequential, single coder.

- New page: `docs/src/content/docs/guides/transactions.mdx` covering the API, the per-backend guarantee table, and worked examples (timeline+index, snapshot+observation).
- Update `docs/src/content/docs/guides/extending.mdx` to describe the optional `apply_batch` hook and the fallback semantics.
- Run `bun run docs:build` (regenerates `llms.txt`).
- Update `AGENTS.md` "Gotchas" with the read-your-writes + no-isolation note.

Exit: docs build passes; `llms.txt` updated.

### Parallelisation summary

| Phase | Mode | Why |
|-------|------|-----|
| 1 | Sequential | Foundation; everything else depends on the new types |
| 2 | 2 parallel | Memory impl + contract test scaffold are independent |
| 3 | Sequential | File staging logic needs careful reasoning |
| 4 | Sequential | D1 batch refactor touches existing put paths |
| 5 | Sequential | Small, fast, touches all backends |
| 6 | Sequential | Doc site — a coder runs build at the end |

---

## 9. Testing strategy

Extend `tests/integration/backend-contract.test.ts` with one shared `describe('transaction contract')` suite that runs against every backend that implements `apply_batch`. Test cases:

- **Atomic success** — three puts across two stores commit; all three are readable after; metadata `find_by_hash` reflects the puts; data is present.
- **Atomic abort (returned error)** — body returns `err({ kind: 'invalid_config', message: 'test' })`; no writes are visible after; result is `{ kind: 'transaction_aborted', cause: <invalid_config>, rolled_back: 2 }`.
- **Atomic abort (thrown)** — body throws `Error('boom')`; same outcome.
- **Partial-failure rollback** — inject a failure on the second `apply_batch` op (memory: monkey-patch a single op to throw; file: pre-create a directory at the target rename path; cloudflare: violate a unique constraint). Assert the first op is undone.
- **Read-your-writes** — `tx.put(store, v1)` then `tx.get(store, returned_version)` returns the in-tx value without hitting the backend.
- **Dedup within tx** — two puts of identical bytes produce one data write but two metadata entries with the same `data_key`.
- **Observations participate** — `tx.put(snapshot)` then `tx.observe({ source: snapshot_pointer })`; abort the tx; both are gone.
- **Concurrent tx** — two `transaction()` calls running concurrently against the same store. Document that we do NOT guarantee isolation; the test asserts only that each tx individually commits or aborts — never partial commits — and that no internal invariant is violated.

For the Cloudflare backend specifically, add an ordering test (no real D1 needed): a fake D1 records the call sequence; assert R2 puts complete before the single D1 batch call.

---

## 10. Open questions

All resolved 2026-05-05.

1. ~~**Nested transactions.**~~ **RESOLVED:** Error with `kind: 'invalid_config'` for v1; revisit if a real use case appears.
2. ~~**Timeout / deadlock.**~~ **RESOLVED — no built-in timeout.** Consumers use `Promise.race` themselves.
3. ~~**Staging-dir inspection on file backend.**~~ **RESOLVED — internal.** Provide a documented `recover()` helper for cleanup. No enumeration API.
4. ~~**R2 orphan GC.**~~ **RESOLVED — follow-up work.** Out of scope for this plan. Tracked as a TODO in `README.md` (and in §12 AGENTS.md "Gotchas" addition). Follow-up shape: a `corpus.gc()` method that scans D1 for live `data_key`s and lists R2 objects not in that set.
5. ~~**Concurrency control opt-in (`version_check`).**~~ **RESOLVED — defer.** Useful but adds API surface; revisit if a real use case appears.
6. ~~**`tx.delete` / `tx.observation_delete`.**~~ **RESOLVED — yes, include in v1.** `meta_delete` and `observation_delete` are already in `BatchOp`; surface them on the handle. Phase 1 scope expanded to include these methods.
7. ~~**`Object.freeze` invariant check on memory snapshots.**~~ **RESOLVED — yes, behind a `dev` flag.** Too expensive in hot paths but useful in development.

---

## 11. devpad tasks (proposed; do not create yet)

| Title | Description |
|-------|-------------|
| Cross-store atomic: types & callback API | Add `BatchOp`, `TransactionHandle`, error kinds, optional `Backend.apply_batch`, `Corpus.transaction` (Phase 1) |
| Cross-store atomic: memory backend impl | Snapshot-rollback `apply_batch` on memory backend (Phase 2A) |
| Cross-store atomic: contract test suite | Transaction contract tests in `backend-contract.test.ts` (Phase 2B) |
| Cross-store atomic: file backend impl | Staged-rename `apply_batch` + recover() helper for file backend (Phase 3) |
| Cross-store atomic: cloudflare backend impl | D1 `db.batch()` + R2 ordering for Cloudflare backend (Phase 4) |
| Cross-store atomic: observations integration | Wire `tx.observe()` and observation ops into all backends (Phase 5) |
| Cross-store atomic: docs | New transactions guide + extending guide update + llms.txt regen (Phase 6) |

Priority order matches phase order. Dependencies: each phase blocks the next.

---

## 12. Suggested AGENTS.md updates

Two additions for the **Gotchas** section:

- `corpus.transaction(async tx => …)` provides batched cross-store puts. It uses `Backend.apply_batch` if present and otherwise falls back to sequential best-effort with compensating deletes. Custom backends should implement `apply_batch` for real atomicity.
- corpus does NOT guarantee isolation between concurrent `transaction()` calls. Each call commits or aborts as a unit, but two concurrent transactions touching overlapping `(store_id, version)` keys may race — last writer wins (memory, file) or surfaces `concurrent_modification` (cloudflare D1 unique constraint).

One addition for the **Conventions / Error handling** section:

- `CorpusError` gained `transaction_aborted`, `partial_commit`, and `concurrent_modification` kinds. Exhaustive switches in downstream code must add cases (this is enforced by TypeScript).

Present these to the user; do not write directly.
