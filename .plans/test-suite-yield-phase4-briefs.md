# Phase 4 coder briefs: close the gaps, in-process CLI, coverage gate

Plan: `.plans/test-suite-yield.html#phase-4`
Devpad: `task_c453a4e2-dfec-4bac-aad6-703a80175519` (existing; the reviewer marks it done at C17)
Branch: `test/suite-yield`, HEAD `8b0926b`. Every symbol and line below was checked against `8b0926b`; line numbers are approximate (≈).

## Fresh baseline (`bun test --coverage` at 8b0926b; 848 tests, 54 files)

Lib files below 80% on lines or functions (`% funcs | % lines`):

| File | Funcs | Lines | Uncovered (key) | Owner |
|---|---|---|---|---|
| `cli/commands/show.ts` | 33.3 | 61.2 | 35-50 (resolve path), 66, 73-80 (json obs), 99-122 (parents, obs table) | 4.4 |
| `cli/commands/cat.ts` | 42.9 | 73.5 | 40-43 (missing args), 93-120 (config-codec decode), 155-164 (json parse error) | 4.4 |
| `cli/commands/stores.ts` | 100 | 70.7 | 21-43 (resolve path), 47-50 (no `list_stores`), 63-64, 72-73 (listing errors) | 4.4 |
| `cli/commands/versions.ts` | 75 | 72.1 | 38-59 (bad `--before`/`--after`), 78-93 (resolve path) | 4.4 |
| `cli/commands/lineage.ts` | 100 | 77.6 | 33-37 (missing args), 56-71 (resolve path), 92-93 (missing parent), 144, 168-172 | 4.4 |
| `cli/lookup.ts` | 80 | 75.8 | 6-10 (`store_not_found`), 17, 51-52 | 4.4 |
| `cli/output.ts` | 88.6 | 78.1 | 58-64 (default process sinks), 111-119 (`write_fatal`), 260-282 (`describe_error` per kind) | 4.4 |
| `cli/wrangler.ts` | 77.8 | 81.1 | 47-51 (read error mapper), 65-71 (jsonc block comment), 107-111 (parse error), 125-129 (invalid structure), 169-174 (env `r2_buckets`) | 4.4 |
| `cli/load-config.ts` | 75 | 86.1 | 34-38 (import failure mapper) | 4.4 |
| `cli/config-schema.ts` | 0 | 92 | 32-33 (`define_config`) | 4.4 |
| `backend/remote-r2.ts` | 76.9 | 93.2 | 109, 139, 148 (error-mapper arrows in get/delete/exists) | 4.2 |
| `testing/laws/equality.ts` | 100 | 50 | 17-19 (no-Bun branch) | 4.5 |
| `sst.ts` | 0 | 0 | all | 4.6 (ignore pattern, no test) |

Not loaded in-process today: `cli/index.ts`, `cli/commands/index.ts`. After 4.3, `cli/main.ts` and `cli/commands/index.ts` enter lcov, and `cli/index.ts` becomes a 5-line shim that stays out.

Already ≥80% but named in the plan: `corpus.ts` 90.2/82.2 (4.1), `backend/remote-d1.ts` 100/81.7 (4.2).

## Waves, worktrees, order

| Wave | Task (commit) | Worktree | Kind | Depends on |
|---|---|---|---|---|
| 0 | 4.0a (C12a): `coverage:diff --by-content` | `p4-cov-content` | scripts | none |
| 0 | 4.0b (C12b, **optional**): model hit-rate floors | `p4-hit-rate` | tests | none |
| 1 | 4.1 (C12): `corpus.ts` tx, compensation and pointer gaps | `p4-corpus` | tests | Wave 0 |
| 1 | 4.2 (C13): remote-d1 / remote-r2 error paths | `p4-remote-errors` | test fakes + tests | Wave 0 |
| 1 | 4.3 (C14): `cli/main.ts` + `cwd` seam + in-process entrypoint + selector guards | `p4-cli-main` | **lib** + tests | Wave 0 (needs `--by-content`) |
| 1 | 4.5 (C14b): `equality.ts` Bun-presence seam | `p4-equality` | **lib** (tiny) + test | Wave 0 |
| 2 | 4.4 (C15): command error branches + CLI stragglers | `p4-cli-errors` | tests | **4.3 committed** (uses `load_cli_config(path, cwd)` and `run_cli`) |
| 3 | 4.6 (C16): coverage gate in CI + gate | `p4-gate` | config | everything above committed |
| 4 | 4.7 (C17): AGENTS.md + release notes | `p4-agents` | docs | 4.6 committed. Then the reviewer opens the **ONE PR** and ships. |

**Order rationale**
- `--by-content` lands first because 4.3 and 4.5 edit lib files, and line-number `coverage:diff` reports false losses after lib edits (Phase 3 proof).
- 4.4 waits for 4.3 because it drives commands through the new `cwd` seam.
- The gate goes last, after the tree really meets 80% per file. AGENTS.md goes after the gate so it describes the final state.

**Reviewer per unit**
- Gate the worktree in place (with the `node_modules` symlink).
- `bun run coverage:diff --base <unit base> --by-content` (once 4.0a lands).
- `bun run mutate tests/mutations/<manifest>.ts`.
- Cherry-pick linearly.
- Re-run `mutate tests/mutations/guards.ts` on the integrated tip.

---

## Shared header (paste above every brief)

> **Where you work**
> - Repo `/Users/tom/dev/corpus`. Work ONLY in your assigned worktree.
> - Plan: `.plans/test-suite-yield.html#phase-4`. Devpad: `task_c453a4e2-dfec-4bac-aad6-703a80175519`.
>
> **What you can run.** `bun run typecheck`, `bun run lint`, `bun run fmt` (node_modules is symlinked). Run all three before handing off and fix what they report.
> - **Not** `bun test`, builds, installs or git. The reviewer runs tests, `coverage:diff` and `mutate`.
> - **You have no delete tool.** List files to delete under **Reviewer deletions**; the reviewer runs `git rm`.
>
> **Verify against HEAD before you write**
> - Every symbol, line and test name in this brief was checked at `8b0926b`. Line numbers are approximate.
> - If the code disagrees with the brief, **follow the code and say so**. Don't invent APIs.
> - Before listing any test for deletion, confirm that no other test reaches the same lib lines via another entry point. `corpus.ts` entry points (`store.*`, `corpus.transaction`, `resolve_pointer`, `is_superseded`) are reached from several files. The reviewer's `coverage:diff` is authoritative.
>
> **Mutation manifests** (`tests/mutations/<name>.ts`)
> - Format: `export const manifest = { … } satisfies MutationManifest` (copy the shape of `guards.ts`).
> - Each `find` matches exactly once and typechecks after replacement.
> - **Every mutant must bite** a path your tests drive; no equivalent mutants.
> - Phase 4 is mostly additive, so mutants that survive old and die new are expected and good. Zero regressions are required where you convert or delete tests.
>
> **Test conventions**
> - `bun:test`, in-memory fakes only (no `mock`/`spyOn`).
> - `make_tmp_dir` from `tests/support/tmp.ts` for any disk path; never a fixed temp path.
> - Tests import root `zod`. `fc.*` payloads, never `testing.compose`, inside models.
>
> **Typed-ESLint traps** (lint will flag these; fix them before handing off)
> - `restrict-template-expressions` → `String(x)`.
> - `no-confusing-void-expression` → braces on void arrows.
> - `toSorted`/`toReversed`, never `sort`/`reverse`.
> - `consistent-function-scoping` → helpers that capture nothing go at module scope.
> - No non-null `!`. No `any`. As few `as` casts as possible.
> - Await every promise.
> - Relative imports end in `.js`. snake_case identifiers, kebab-case files.
> - **Lib code** (not `tests/**`): Result types, no throw/try (except the documented boundaries), `must-use-result` is on, and `no-console` is a full ban.
>
> **Hands off** unless your brief says otherwise: `AGENTS.md`, `eslint.config.ts`, `package.json`, `bunfig.toml`, `.github/`.
>
> **Skills:** `pipelines-setup`, `corpus-patterns`, `testing-strategy`.
>
> End your report with **Reviewer deletions**, **Brief/code mismatches found**, then `## Process feedback`.

---

## 4.0a (C12a): `coverage:diff --by-content`

**Worktree:** `p4-cov-content`. **Files:** `scripts/coverage-diff.ts`, `scripts/lib/lcov.ts` (or a new `scripts/lib/content-key.ts`).

**Why.** `diff_file` compares covered **line numbers**. Any lib edit shifts lines, and the Phase 3 proof had to hand-compare text to clear 8 false "lost" files.

**Scope**
- Add a `--by-content` flag (default stays line-number, for backwards compatibility).
- In by-content mode, for each lib file on each side, read its source from that side's tree: the base worktree dir, or `repo_root` for head.
- Key every source line as `` `${line.trim()}\u0000${String(k)}` ``, where `k` is the 0-based occurrence index of that trimmed text **among all lines of the file**, not just covered ones. Skip blank lines and lines that are only `}`/`};`/`)`/`});`/`]`, because braces are noise.
- Covered key set = keys of covered line numbers.
- **lost** = base covered key ∉ head covered keys **and** the key still exists in head's source. That's a real loss: the same code is now uncovered.
- **removed** = base covered key whose text no longer exists in head. That's an edit, so report it as info, not a failure.
- **gained** as before.
- Function hits keep their existing FNH rule.
- Output adds a `removed N (edited)` line per file. The exit code is 1 only for real losses or an FNH drop.
- Read files with `Bun.file(...).text()` behind `try_catch_async`. A file present on one side only is handled like today.

**Self-test.** Add `tests/unit/coverage-diff-content.test.ts` with a pure function, `content_diff(base_src, base_lines, head_src, head_lines)`, exported from the lib module:
- a 3-line insertion above covered code gives no loss;
- an edited covered line gives `removed` and no loss;
- the same text duplicated twice with only the second covered keeps its occurrence index;
- genuinely uncovering an unchanged line gives a loss.

**Mutations** (`tests/mutations/coverage-diff.ts`):
1. Occurrence index always 0.
2. `removed` counted as `lost`.
3. Keys built from untrimmed lines.
4. Brace-only lines not skipped.
5. `lost` ignores whether the text still exists in head.

**Acceptance (reviewer).** `bun run coverage:diff --base 7544fe5 --by-content` on the current tip reports **no lost lines**. That run is the Phase 3 false-loss case: the reviewer confirms the 8 files now show `removed` only. A deliberate local test deletion (`tests/unit/cli-args.test.ts`) still fails.

**Reviewer deletions:** none.

---

## 4.0b (C12b, optional; skip if it costs more than about an hour): model hit-rate floors

**Worktree:** `p4-hit-rate`. **Files:** `tests/property/backend-equivalence.test.ts`, `tests/property/observations-equivalence.test.ts`.

**Why.** Command-type share proves a command ran, not that it hit an interesting branch. A `get` that always misses, or a `list` that is always empty, still passes the share floor.

**Scope**
- In each `on_model`, bump an outcome label next to the existing type counter:
  - `get_meta:hit|miss`;
  - `list_meta_filtered:nonempty|empty` and `:limited` (limit actually truncated);
  - `get_latest:hit|miss` and `:tie` (≥2 candidates share the max `created_at`);
  - `find_by_hash:found|absent`;
  - `get_children:nonempty`;
  - observations `query:nonempty`, `delete_by_source:removed>0`, `is_stale:true|false`.
- After the run, assert each listed "interesting" label is ≥2% of its command's calls.
- Don't change the command generators unless a floor fails. If one fails, report the measured rate instead of weakening the floor; the reviewer decides.

**Mutations:** none (test-only measurement). The reviewer checks the floors hold on 3 consecutive runs (`bun test tests/property/*-equivalence.test.ts` ×3).

**Reviewer deletions:** none.

---

## 4.1 (C12): `corpus.ts` gaps

**Worktree:** `p4-corpus`.

**Files**
- New `tests/integration/transaction-compensation.test.ts`.
- New `tests/integration/pointers.test.ts`.
- New `tests/mutations/corpus-gaps.ts`.

**Uncovered at `8b0926b`:**

| Area | Lines |
|---|---|
| Error emits on encode failure | 53-54, 255-259, 269-274 |
| Error emits on other failures | 122-124, 157-160, 207-211, 224-228 |
| `find_tx_latest` null | 469 |
| `tx.put` unregistered store | 474-476 |
| `tx.put` with a store `data_key_fn` | 501-504 |
| `tx.get` dedup-hit live read | 547-552 |
| `tx.get_latest` | 557-561 |
| `tx.observe` validation error | 576-582 |
| `tx.observation_delete` | 608-611 |
| `partial_commit` passthrough | 639-640 |
| **All of** `resolve_pointer_impl` and `is_superseded_impl` | 652-686 |
| `sequential_apply_with_compensation` | 730-760 |
| `apply_single_op` `meta_delete` / observation ops | 770-771, 785-789 |
| `compensate_op` `observation_put` | 800-809 |

**Scope: `transaction-compensation.test.ts`.** The sequential fallback runs for backends without `apply_batch`. Build the SUT as `{ ...create_memory_backend(), apply_batch: undefined }`, or omit the key via destructuring; the remote backend has none but is HTTP-heavy. Wrap it with a **fail-after-N** fake: a backend whose `metadata.put` / `data.put` / `metadata.delete` delegate to memory and return `err({ kind: "storage_error", … })` once N calls have passed. Same style as `copy.test.ts`'s interrupted-copy fake, and no `spyOn`.

| Scenario | Expected |
|---|---|
| put A, put B; B's `metadata.put` fails | `transaction_aborted` (`reason: "apply_batch_failed"`), and A's meta **and** data are compensated (gone) |
| `tx.delete` of a committed version, then a failing put | `partial_commit` (`meta_delete` is non-undoable), and `ops_completed`/`ops_failed` are right |
| the compensating delete itself fails (fail on the undo call) | `partial_commit` whose `cause` is the compensation error |
| `tx.observe` on a backend without `apply_batch` | the fallback returns the `invalid_config` "observation ops in transactions require backend.apply_batch" error, surfaced as `transaction_aborted` |
| `tx.observation_delete` | same path |

Also cover:
- `tx.get_latest` (buffered beats live, tombstoned is skipped, store with nothing gives `not_found`);
- `tx.get` of a buffered put whose data deduped to a live blob (put identical content twice across a commit);
- `tx.put` to a store not registered on this corpus gives `invalid_config`;
- `tx.put` to a store with a `data_key_fn` uses that key;
- `tx.observe` with invalid content gives `validation_error`.

**Scope: `pointers.test.ts`.** Use `corpus.resolve_pointer` and `corpus.is_superseded`, the instance methods from AGENTS.md:

| Case | Expected |
|---|---|
| Unknown store | `not_found` |
| Unknown version | `not_found` |
| `path` resolution ok | the value at the path |
| `path` through a primitive | the `resolve_path` error |
| `span` on a string value ok | the slice |
| Out-of-range span | the `apply_span` error |
| `span` on a non-string | ignored |
| `is_superseded` without observations | `false` |
| `is_superseded` with an older version | `true` |
| `is_superseded` with the latest version | `false` |

**Error emits.** One table test: a corpus built with `on_event` over a backend whose single op fails (`tests/fakes/throwing-data-storage.ts` exists for data, and fail-after-N for metadata), plus a codec whose `encode` throws. For each store op (`put`, `get`, `get_meta`/`get_handle`, `put_stream`), assert an `error` event and the error Result.

**Mutations** (≥8):
1. `compensate_op` `meta_put` → `ok(undefined)` without the delete.
2. The `meta_delete` non-undoable branch no longer sets `compensation_failed`.
3. `partial_commit` `ops_failed` off by one.
4. `resolve_pointer_impl` skips `apply_span`.
5. `resolve_pointer_impl` ignores `pointer.path`.
6. `is_superseded_impl` always `false`.
7. `tx.get_latest` ignores tombstones.
8. `tx.put` unregistered-store check removed.
9. The encode-error `emit` removed.

**Reviewer deletions:** none.

---

## 4.2 (C13): remote adapter error paths

**Worktree:** `p4-remote-errors`.

**Files**
- `tests/fakes/d1-http.ts`, `tests/fakes/s3.ts`: add `set_responder`.
- `tests/integration/http-fakes.test.ts`: fidelity tests for `set_responder`.
- New `tests/integration/remote-errors.test.ts`.
- New `tests/mutations/remote-errors.ts`.

**Fake hook (single source; no second fake).** Both fakes gain `set_responder(fn: ((req: Request) => Response | Promise<Response> | undefined) | undefined): void`:
- The server's `fetch` calls the responder first.
- A returned `Response` wins; `undefined` falls through to normal behaviour.
- `reset()` also clears the responder.
- Existing quirks are untouched.

**`remote-errors.test.ts`** uses a `create_remote_backend` over one fake pair per file (`beforeAll`/`afterAll`, `reset()` per test). Table-driven over D1 envelopes, `backend/remote-d1.ts` ≈ 125-196:

| Case | Responder / setup | Covers |
|---|---|---|
| network failure | point `d1_base_url` at a stopped server's URL | 132-134 "D1 HTTP request failed" |
| non-2xx | `new Response("boom", { status: 500 })` | the HTTP-error branch |
| non-JSON 200 | `new Response("not json", { status: 200 })` | 146-148 |
| wrong shape | `Response.json({ hello: 1 })` | 154 |
| `success:false` | `Response.json({ success: false, errors: [{ code: 7500, message: "x" }], result: [] })` | the SQL-error branch |
| empty result | `{ success: true, errors: [], result: [] }` | 167 |
| statement failed | `{ success: true, errors: [], result: [{ success: false, error: "bad" }] }` | 172 |
| no `results` | `{ success: true, errors: [], result: [{ success: true }] }` on a `metadata.delete` | 178 (ok path) |
| `get` with zero rows | normal fake; `metadata.get` of a missing version | 187-189 (`not_found`) |

**Each error case asserts:**
- the backend op returns `storage_error`, and an `error` event fires;
- the error message never contains the `api_token` string.

**R2 cases**, `backend/remote-r2.ts` 109, 139, 148. Make the S3 responder return 500 for HEAD / DELETE, then:
- `data.exists` → `false`;
- `data.get` → `not_found` (the exists probe failed);
- `data.delete` → ok (errors deliberately swallowed).

These are the error-mapper arrows that count as functions.

**Mutations** (≥6):
1. The `!response.ok` check removed.
2. The `success:false` check removed.
3. The empty-result check removed.
4. The statement-failed check inverted.
5. remote-r2 `exists` catch → `() => true`.
6. remote-r2 `get` returns a handle when the exists probe errors.

**Reviewer deletions:** none.

**Tripwire.** The `set_responder` fidelity test must prove fall-through: an `undefined` return yields the normal response.

---

## 4.3 (C14): `cli/main.ts` extraction, `cwd` seam, in-process entrypoint, selector guards

**Worktree:** `p4-cli-main`. **Lib change, behaviour-preserving.**

**Files**
- New `cli/main.ts`.
- `cli/index.ts` (becomes a shim).
- `cli/load-config.ts`.
- `cli/commands/{cat,show,stores,versions,lineage,clone}.ts` (pass `ctx.cwd`).
- `tests/integration/cli-entrypoint.test.ts`.
- `tests/unit/cli-output.test.ts` (its `cli spawn smoke test` describe).
- New `tests/unit/cli-main.test.ts`.
- `tests/mutations/guards.ts`.
- New `tests/mutations/cli-main.ts`.

### 1. `cli/main.ts`

```ts
export type CliIo = {
  argv: readonly string[];                       // already sliced (no bun/script)
  env: Record<string, string | undefined>;
  cwd: string;
  stdout_is_tty: boolean;
  stderr_is_tty: boolean;
  stdout_write?: (chunk: string | Uint8Array) => void;
  stderr_write?: (chunk: string) => void;
};
export async function run_cli(io: CliIo): Promise<number>;          // exit code 0 | 1 | 2
export function build_backend_selector(g: GlobalArgs): BackendSelector & { config?: string };
```

**Move** the body of `main()` and `render_usage()` from `cli/index.ts` into `main.ts`:
- every `process.exit(n)` becomes `return n`;
- `process.argv`, `process.env`, `process.cwd()` and the `isTTY` reads become `io.*`;
- `no_color = io.env.NO_COLOR !== undefined`, `ci = io.env.CI !== undefined`;
- writers are passed into `create_console_output` (`OutputOpts` already accepts `stdout_write`/`stderr_write`).

**Unexpected throws:** `run_cli` wraps the command execution in `try_catch_async`. On a throw it calls `write_fatal(error, io.env.CORPUS_DEBUG === "1", io.stderr_write)` and returns 1. That is a sanctioned boundary; if lint needs it, add a why-commented `files: ["cli/main.ts"]` override in `eslint.config.ts`. This is the one allowed `eslint.config.ts` edit, and an inline disable is never allowed.

**`build_backend_selector`** returns only the keys whose values are defined: the existing conditional spreads, moved and exported so a test can assert key presence.

### 2. `cli/index.ts` shim

Reads `process.*` **once** and calls `run_cli`:

```ts
#!/usr/bin/env bun
import { run_cli } from "./main.js";
process.exit(await run_cli({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdout_is_tty: Boolean(process.stdout.isTTY), stderr_is_tty: Boolean(process.stderr.isTTY) }));
```

Keep the shebang. This preserves AGENTS.md's "TTY/env detection happens exactly once, at the entry".

### 3. `cwd` seam

`load_cli_config(explicit_path?: string, cwd: string = process.cwd())` searches upward from `cwd` (≈ line 25). All six commands pass `ctx.cwd`. Without this, in-process tests can't point config discovery at a temp dir.

### 4. `cli-entrypoint.test.ts`

Convert its spawned tests to **in-process** `run_cli` calls:
- keep the same fakes (`create_fake_d1_http` + `create_fake_s3`), the same temp `corpus.config.ts` and the same assertions (stdout, stderr, exit code);
- capture with `stdout_write`/`stderr_write` arrays;
- pass `env` explicitly (secrets via env, never a config file).

Keep exactly **3 spawn smokes**, in one `describe("spawn smoke")`:
1. `--help` exits 0 with usage on stdout;
2. `unknown` exits 2;
3. the remote round trip `stores --json` exits 0 with JSON on stdout and nothing on stderr. This one proves the shim really reads `process.*`.

**Reviewer deletions:** none (the file is edited, and `cli-output`'s spawn describe is removed by editing). In `tests/unit/cli-output.test.ts`, remove the `describe("cli spawn smoke test")` block (4 spawn tests); the smokes above replace them. Keep everything else in that file.

### 5. `cli-main.test.ts`

- `build_backend_selector` never emits a key with an `undefined` value (property over `fc.record` of optional `env`/`file`/`config` strings: `Object.values(sel).every(v => v !== undefined)`, and `"file" in sel` exactly when `file` was given).
- `run_cli` exit codes: 0 help, 2 no command, 2 unknown command, 1 command-arg parse error, 1 command error.
- `--json` error document on stdout.
- `CORPUS_DEBUG=1` prints the stack through the injected `stderr_write` when a command throws. Drive it with a `corpus.config.ts` in a temp cwd whose import throws a non-Result error, if `load_cli_config` surfaces that as a Result. If no throwing path is reachable without test-only hooks, test `write_fatal` directly with an injected sink and **say so**.

### 6. Guards (`tests/mutations/guards.ts`)

These were killable only after this task; see the Phase 1 proof. Both layers need their own guard, because the original bug needed **both** halves and a single-site mutant is equivalent while the other half holds:

| Guard id | Mutation | Killed by |
|---|---|---|
| `guards/selector-builder-leaks-undefined` | `build_backend_selector`'s file spread becomes `file: g.file` | the `cli-main` key-presence property |
| `guards/resolve-backend-file-key-presence` | `cli/resolve-backend.ts` `selector.file !== undefined` → `"file" in selector` | a new test in `cli-main.test.ts` calling `resolve_backend({ file: undefined, env: "remote" } as BackendSelector, …)` and asserting the remote path is taken (with a missing token it's `invalid_config` naming `CLOUDFLARE_API_TOKEN`, not a file backend) |

Add `tests/unit/cli-main.test.ts` to that manifest's test lists. The `{ file: undefined }` literal needs no cast if `BackendSelector` allows it; check `exactOptionalPropertyTypes` in `tsconfig.json` (off at HEAD).

### Mutations (`tests/mutations/cli-main.ts`, ≥6)

1. `return 2` for an unknown command → `return 1`.
2. Help returns 1.
3. `no_color` reads `io.env.CI`.
4. `load_cli_config` ignores the `cwd` argument (uses `process.cwd()`).
5. `run_cli` drops the `--json` flag passthrough to `ctx.json`.
6. `write_fatal` debug flag forced `false`.

### Acceptance (reviewer)

- `bun run coverage:diff --base <unit base> --by-content`: no real losses. `cli/index.ts` drops out and `cli/main.ts` plus `cli/commands/index.ts` enter.
- `bun cli/index.ts --help; echo $?` prints 0.
- The `cli-entrypoint` file runtime drops from about 2.5 s to ≤0.6 s.
- Both new guards are killed. `mutate tests/mutations/cli-main.ts` shows 0 regressions; old = spawn tests, so spawn-side survivors are expected since the old coverage was invisible.

**Tripwires**
- Don't change the exit-code contract, stdout/stderr routing, or the `--json` single-document rule.
- Don't read `process.*` anywhere except `cli/index.ts` and `output.ts`'s default sinks.
- `parse_global_args` already takes an argv array.
- Dynamic `import()` of the same config path is module-cached, so each in-process test that changes config content must use its own temp dir.

---

## 4.5 (C14b): `equality.ts` Bun-presence seam

**Worktree:** `p4-equality`. **Files:** `testing/laws/equality.ts`, `tests/unit/testing-laws-basic.test.ts`, new `tests/mutations/equality.ts`.

**Scope**
- Change the signature to `default_equals<T>(law: string, has_bun: boolean = typeof Bun !== "undefined")`.
- Callers stay unchanged (they pass only `law`; grep `default_equals(` under `testing/laws/`).
- Test that `default_equals("round_trip", false)` throws, with a message naming `round_trip` and `opts.equals`.
- Test that `default_equals("x", true)(a, b)` deep-compares.
- `default_equals` is not exported from `testing/laws/index.ts` at HEAD (check). If it is, the parameter is an additive public change; note it.

**Mutations:**
1. The message omits `${law}`.
2. `has_bun` ignored (always the Bun branch).

**Reviewer deletions:** none.

---

## 4.4 (C15): command error branches and CLI stragglers

**Worktree:** `p4-cli-errors`, branched **after 4.3 is committed**.

**Files**
- New `tests/integration/cli-errors.test.ts`.
- Edit `tests/unit/cli-config.test.ts` (wrangler / load-config / `define_config` cases only).
- New `tests/mutations/cli-errors.ts`.

### Scope

**1. Resolve path** (≈ 35-50 in show, 21-43 in stores, 78-93 in versions, 56-71 in lineage, and the equivalents in cat/clone).
- Call each command's `run(ctx)` **without** `_test_backend`: `cwd` = a `make_tmp_dir` dir (no config, no wrangler) and `backend_selector: { file: <tmp file-backend dir> }`, seeded through `create_file_backend` first.
- One success case per command.
- One failure case per command, using a temp dir containing a malformed `wrangler.toml`. The sniff error propagates.

**2. Argument errors**
- cat / lineage with missing positionals;
- `lineage --depth 0` and `--depth x`;
- `versions --before 2025-01-01` (bare date, rejected per AGENTS.md) and a bad `--after`.

**3. Command branches**

| Command | Case |
|---|---|
| `cat` | a store defined in a temp `corpus.config.ts` whose `codec.decode` returns a value: table and `--json` paths |
| `cat` | a decode that throws gives `decode_error` |
| `cat` | `application/json` content that isn't valid JSON gives `decode_error` (≈ 152-164) |
| `show` | snapshot with parents, with and without `role` (table rows) |
| `show` | observations present (table and `--json` `observations[]`) |
| `show` | a backend without observations gives the note |
| `stores` | a backend with `list_stores` removed (`{ ...b, metadata: { ...b.metadata, list_stores: undefined } }`) gives `invalid_config` |
| `stores --counts` | when the listing fails (an `on_event` tracker plus a failing `list`) |
| `lineage` | a parent that doesn't exist renders `(missing)` |
| `lineage` | `max_depth` truncation |

**4. `cli/lookup.ts`:** `store_not_found` for `versions` on an empty store; `ensure_store` propagating a non-`not_found` error.

**5. `cli/output.ts`:**
- one table test over **every** `CorpusError` kind (typed `{ [K in CorpusError["kind"]]: CorpusError }` so a 13th kind breaks compile), asserting the `--json` error document `{ error: { kind, message } }` with `message === describe_error(...)` semantics (prefix-free);
- `write_fatal(error, true, sink)` prints the stack;
- `write_fatal(non_error, false, sink)` prints `corpus: <String>`.

**6. `cli/wrangler.ts`** (in `cli-config.test.ts`):
- an unreadable path: a directory named `wrangler.toml`, which makes `Bun.file().text()` reject;
- jsonc with a `/* block */` comment;
- invalid TOML/JSON gives a parse `validation_error`;
- valid syntax with the wrong structure gives "invalid wrangler.* structure";
- an env-scoped `r2_buckets` entry.

**7. `cli/load-config.ts`:** a `corpus.config.ts` that throws at import gives the `validation_error` "failed to load config…". **`cli/config-schema.ts`:** `define_config(x) === x`.

### Mutations (≥8)

1. `versions` accepts a bad `--before` (skip the `safeParse` failure).
2. `lineage --depth 0` accepted (`parsed < 1` → `parsed < 0`).
3. `cat` decode-error mapper returns ok.
4. `show` drops the parents block.
5. `stores` missing-`list_stores` guard removed.
6. `describe_error` `validation_error` drops its "Validation failed: " prefix.
7. `strip_jsonc` block-comment branch skipped.
8. wrangler invalid-structure check removed.
9. `load_cli_config` import-failure mapper returns `ok(null)`.

### Acceptance (reviewer)

A fresh `bun test --coverage` shows **every `cli/**` file ≥80% lines and functions**. Don't delete any existing `cli-read`/`cli-clone` test.

**Reviewer deletions:** none.

---

## 4.6 (C16): coverage gate in CI and `gate`

**Worktree:** `p4-gate`. **Files:** `bunfig.toml`, `.github/workflows/ci.yml`, `package.json` (`gate`), and `scripts/lib/lcov.ts` only if its exclusion list must mirror the new ignore patterns.

**Scope**
- **`bunfig.toml` `[test]`:**
  - Replace the stale comment with a short one: the per-file floor is enforced via `bun test --coverage` in CI and `gate`, and ignores are listed below with reasons.
  - Set `coverageThreshold = { lines = 0.8, functions = 0.8 }`.
  - Set `coveragePathIgnorePatterns = ["tests/**", "docs/**", "scripts/**", "sst.ts"]`, with a why-comment per entry. **`sst.ts`:** "9-line IaC resource-naming helper (`createCorpusInfra`); only meaningful inside an SST app, so it's deliberately untested (plan Q2)". **`tests/**`:** fakes and fixtures aren't product code (the fakes sit around 78%).
- **CI:** in `.github/workflows/ci.yml`, change the "Run tests" step to `bun test --coverage`. The zod3 step (`bun run test:zod3`) stays **without** coverage.
- **`package.json` `gate`:** change `bun test` to `bun test --coverage`. Leave `test:zod3` alone.

**Acceptance (reviewer, proves exit codes, not printed tables)**

```sh
bun run gate; echo $?                                      # 0
# temporarily set lines = 0.99 → bun test --coverage; echo $?   → non-zero; revert
bunx bun@1.3.13 test --coverage; echo $?                   # 0 on the CI-pinned bun
# same 0.99 probe on 1.3.13 → non-zero
bun test --coverage 2>&1 | grep -E "sst.ts|tests/fakes"   # no rows (ignore patterns honoured on both versions)
```

**Fallback.** If bun 1.3.13 doesn't support `coveragePathIgnorePatterns` or the object threshold, report it. **Don't** silently bump the CI bun pin; that's a separate decision.

**Mutations:** none (config). The 0.99 probe is the mutation check for the gate.

**Reviewer deletions:** none.

---

## 4.7 (C17): AGENTS.md, release notes, close-out

**Worktree:** `p4-agents`. **Files:** `AGENTS.md` (this task is the exception to the hands-off rule), plus the PR body text, which the reviewer pastes.

### AGENTS.md edits

Update in place; don't append duplicates.

**1. Layout tree.**
- Add `scripts/` (`coverage-diff.ts` with `--by-content`, `mutation-check.ts`, `lib/{lcov,worktree}.ts`), `tests/mutations/`, `tests/support/tmp.ts` and `cli/main.ts`.
- Fix `tests/unit/` and `tests/integration/` comment lists (the `observations-*` files were removed; `observations-contract`, `observations-id`, `transaction-compensation`, `pointers`, `remote-errors`, `cli-errors` and `cli-main` were added).

**2. Scripts.** Add `bun run coverage:diff [--base ref] [--by-content]` and `bun run mutate <manifest> [--base ref]`. `gate` now runs `bun test --coverage` (per-file 80% lines+functions from `bunfig.toml`).

**3. Testing section (conventions).**
- **Two contract suites:** `run_backend_contract_tests` (edges, streaming, transactions, named guards) and `run_observations_contract_tests`.
- **Two models** (`backend-equivalence`, `observations-equivalence`) are the spec for raw CRUD, listing and query semantics across memory, file, layered, cloudflare, remote and wrapped-bytes. A new backend plugs into all four.
- Remote providers share one `Bun.serve` transport per file and get fresh state via `reset()`.
- Observation ids in models are ordinals.
- `set_responder` on the HTTP fakes is how error envelopes are tested.
- In-process CLI via `run_cli(io)`; exactly 3 spawn smokes.
- `make_tmp_dir` only.
- Every law has a fails-when-violated test.
- Hit-rate floors, if 4.0b landed.

**4. New "Test-suite tooling and deletion rule" subsection.**
- A test may be deleted only when `coverage:diff --base <ref>` (use `--by-content` after lib edits) shows no lost lines **and** `mutate tests/mutations/<cluster>.ts` shows 0 regressions **and** it's not on the keep list (type-level tests, documented-bug guards, fake fidelity, reference laws).
- `tests/mutations/guards.ts` re-introduces every documented regression; run it after touching a guarded area.
- A stale-`find` failure means the manifest needs updating.
- Equivalent mutants are dropped and noted.

**5. Gotchas.**
- **Fix stale citations:**
  - "Contract test: 'applies tag filters before limit'" (still exists, but confirm the name);
  - the RemoteBackend transaction-fallback test location (now `transaction-compensation.test.ts` + `remote-backend.test.ts`);
  - the "SnapshotMeta arbitrary coverage gap" note (`backend-equivalence` now uses `entity_key` and pooled dates);
  - the `node:util` parseArgs gotcha's "caught … spawn smoke test" wording (it's now in-process).
- **Add:**
  - `load_cli_config(path, cwd)` searches from the command's `cwd`, never `process.cwd()`, which keeps in-process CLI tests hermetic;
  - `coverage:diff` default is line-number based, so use `--by-content` after lib edits;
  - bun's `coverageThreshold` is per-file and only enforced with `--coverage`, so verify by exit code.

**6. Plans list.** Mark `test-suite-yield.html` complete and add both brief files as references.

### Release notes (the reviewer pastes into the PR body; minor bump to 0.10.0 at the next release, not in this PR)

> **0.10.0 (minor)**
> - **Added:** optional `ObservationPutOpts.id` and an exported `observation_id_schema`, for caller-chosen observation ids. A malformed or repeated id is rejected with `validation_error` on every backend (`transaction_aborted` inside `corpus.transaction`).
> - **Fixed:** layered backend observations now share one id across write layers, so `get`, `delete` and `query` are consistent. `delete_by_source` reports the bottom layer's count and surfaces errors.
> - **Fixed:** the file backend's `list_stores` no longer lists stores whose versions were all deleted.
> - **Behaviour change:** a repeated observation id previously overwrote (memory), duplicated (file) or returned `storage_error` (D1/remote).
> - **Internal:** the CLI entry was extracted to `cli/main.ts` (no user-visible change). The test suite was consolidated into contract suites, model-based equivalence and property laws (1164 → about 850 tests), and a per-file 80% coverage gate is now enforced in CI.

**Close-out (reviewer):** ONE PR for `test/suite-yield`, `ship`, then mark devpad `task_c453a4e2` done.

**Reviewer deletions:** none.
