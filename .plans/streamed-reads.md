# Streaming Reads + Codec Composition

Plan covering two linked features for `@f0rbit/corpus`:

1. **Streaming reads** — surface the existing `DataHandle.stream()` capability through the `Store` API, with a streaming codec path so consumers can decode incrementally.
2. **Codec composition** — a `compose(...codecs)` operator that chains transformations (json → gzip → encrypt etc.), with type-level tracking of whether the resulting codec is streamable.

Linked because the composition rules — "every layer must support streaming decode" — only matter once a streaming consumer exists, and the streaming consumer's type must reject non-streamable compositions at compile time.

---

## 1. Background & motivation

### 1.1 Today

`Store.get(version)` always materialises the full payload:

```ts
const bytes = await data_result.value.bytes()  // corpus.ts:130
const data = codec.decode(bytes)               // corpus.ts:133
return ok({ meta, data })
```

For a 200 MB log dump or a multi-GB media object on R2, that buffers the entire object in worker memory before the consumer sees a single byte. R2 already returns a streaming `body` (`backend/cloudflare.ts:382`). The `DataHandle` contract (`types.ts:181-184`) already exposes a `stream()` method — it was forward-designed for this — but no public API ever calls it.

### 1.2 Today, codec wrappers

Every wrapper (gzip, encrypt, base64, …) requires writing a full `Codec<T>` from scratch, hard-coding the inner serialisation. There's no way to say "JSON over gzip" without a one-off `gzipped_json_codec(schema)` factory. The Codec contract (`types.ts:270-274`) is byte-in / byte-out and not composable.

### 1.3 What we want

- **Streaming reads** with backend-pass-through where supported (R2 native, file via `Bun.file().stream()`, memory wraps in a one-chunk stream).
- **Streaming decode** for codec types that can chunk (`text_codec`, `binary_codec`, `gzip_codec`, `encrypt_codec`'s decrypt is *not* chunked at the consumer end — see §4.2). `json_codec(schema)` cannot stream-decode because Zod validation needs the full document.
- **Composition** that lets you build wrappers without hand-rolling a codec each time, with type inference flowing through the chain and a streamability bit tracked at the type level.

---

## 2. Design decisions

### 2.1 API shape — `DataHandle` over `get_stream`

**Decision: extend `Store.get()` to return a streamable surface, not add `get_stream(version)`.**

Two candidates considered:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| A. Parallel methods | `get(v)` returns `Snapshot<T>`; `get_stream(v)` returns `ReadableStream<T-chunks>` | No type churn on `Snapshot<T>`; obvious naming | Doubles the method count (`get_latest_stream`, `get_meta_stream` vapor); duplicates the metadata fetch |
| B. Lazy snapshot via handle | `get(v)` returns `{ meta, data: T }` (unchanged) plus separate `get_handle(v)` returning `{ meta, handle: SnapshotHandle<T> }` where the handle exposes `.bytes()` / `.stream()` / `.value()` | Keeps `get` cheap and back-compat; only consumers who want streaming pay the streaming cost | One new method on `Store` |
| C. Always return a handle | `get(v)` returns `Snapshot<T>` whose `.data` is now lazy | Single API | Breaking change to every existing consumer reading `snapshot.data` |

**Pick: B.** Add `Store.get_handle(version)` and `Store.get_latest_handle()`. They return `{ meta, handle }` where `handle: SnapshotHandle<T>`:

```ts
// types.ts (additions)
export type SnapshotHandle<T> = {
  /** Decode and materialise the full value. Always available. */
  value(): Promise<Result<T, CorpusError>>
  /** Raw decoded bytes (post-codec-decode is NOT applied). Always available. */
  bytes(): Promise<Result<Uint8Array, CorpusError>>
  /**
   * Stream decoded chunks. Only present when the codec supports streaming decode.
   * The TypeScript signature is conditional on `Codec<T>['decode_stream']` existing.
   */
  stream: T extends StreamableValue ? () => Promise<Result<ReadableStream<T>, CorpusError>> : never
}

export type Store<T> = {
  // ...existing
  get_handle: (version: string) => Promise<Result<{ meta: SnapshotMeta; handle: SnapshotHandle<T> }, CorpusError>>
  get_latest_handle: () => Promise<Result<{ meta: SnapshotMeta; handle: SnapshotHandle<T> }, CorpusError>>
}
```

`StreamableValue` is `Uint8Array | string` for v1 — the types we know how to chunk. (Streaming a structured `T` would require chunked decoding semantics, e.g. NDJSON, which is out of scope here.)

The conditional `stream: T extends … ? … : never` makes `handle.stream()` a compile-time error on a `Store<User>` backed by `json_codec(UserSchema)`.

### 2.2 Codec interface evolution — additive optional methods

**Decision: extend `Codec<T>` with optional `encode_stream` and `decode_stream`. Existing codec implementations are unaffected.**

```ts
// types.ts (additions)
export type Codec<T> = {
  content_type: ContentType
  encode: (value: T) => Uint8Array
  decode: (bytes: Uint8Array) => T

  /** Optional: chunked encode. If absent, store falls back to `encode` + one-chunk stream. */
  encode_stream?: (value: T) => ReadableStream<Uint8Array>

  /**
   * Optional: chunked decode. If absent, the codec is non-streaming on read —
   * `SnapshotHandle.stream()` will not be present in the type.
   *
   * The caller is responsible for ensuring `T` is a chunkable type (string | Uint8Array | …).
   */
  decode_stream?: (bytes: ReadableStream<Uint8Array>) => ReadableStream<T>
}
```

**Why optional and not separate `StreamingCodec<T>` interface?**
- Most consumers don't care. Forcing all codec implementers to declare a streaming variant is gratuitous churn for `json_codec` users.
- The conditional type on `SnapshotHandle.stream` derives from whether `decode_stream` is in the codec's type, so it works with structural typing — no runtime tagging needed.

**Why both `encode_stream` and `decode_stream`?** Encode-side streaming only matters for `Store.put` accepting a stream. That's a separate (smaller) feature — we ship the type field for symmetry and fill in the encode wiring as a follow-up. Out of scope for this plan but flagged in §6.

### 2.3 Composition signature

**Decision: `compose<A, B, C, …>(c1: Codec<A>, c2: BytesCodec, c3: BytesCodec, …): Codec<A>`** where `BytesCodec` is `Codec<Uint8Array>` (a layer that transforms bytes → bytes).

The leftmost codec defines the value type `T`. All downstream layers are byte transformers. Encode runs left-to-right (`A → bytes → bytes' → bytes''`), decode right-to-left.

```ts
// utils.ts (or new codecs/compose.ts)

/** A codec layer that transforms bytes → bytes (gzip, encrypt, base64, …) */
export type BytesCodec = Codec<Uint8Array>

export function compose<T>(
  head: Codec<T>,
  ...layers: BytesCodec[]
): Codec<T> {
  // content_type is the head's; layer wrappers don't change semantic type.
  // Encode: head.encode(v) → fold layers.encode left-to-right
  // Decode: fold layers.decode right-to-left → head.decode

  const decode_streamable = head.decode_stream && layers.every(l => l.decode_stream)
  const encode_streamable = head.encode_stream && layers.every(l => l.encode_stream)

  return {
    content_type: head.content_type,
    encode(value) { /* fold */ },
    decode(bytes) { /* fold reverse */ },
    ...(decode_streamable && {
      decode_stream(stream) {
        // pipe stream through layers[n-1].decode_stream → … → layers[0].decode_stream → head.decode_stream
      }
    }),
    ...(encode_streamable && { encode_stream(value) { /* … */ } }),
  }
}
```

**Why not a fluent `pipe(json).then(gzip).then(encrypt)` API?**
- `compose(...)` reads top-to-bottom in the encode direction, which matches mental model ("JSON, then gzip, then encrypt → store").
- Variadic generics in TS 5 work well enough for the simple "head defines T, rest are byte transforms" shape.
- A fully polymorphic chain (`Codec<A> → Codec<A,B> → Codec<B,C> → Codec<C,Uint8Array>`) is more general but the only realistic non-byte intermediate is `string`, and `text_codec()` already covers that. Not worth the type complexity.

**Streamability as an inferred bit:** `compose` doesn't return a special `StreamableCodec<T>` type — it just conditionally includes `decode_stream` on the returned codec. TypeScript's structural inference picks this up and `SnapshotHandle.stream` becomes available iff every layer had `decode_stream`. No explicit branding needed.

### 2.4 Per-backend streaming behaviour

| Backend | Native streaming? | Implementation |
|---|---|---|
| Memory | No | Wrap `Uint8Array` in a one-chunk `ReadableStream` (already does — `backend/base.ts:127`). Keep as-is. |
| File | Could stream via `Bun.file().stream()` | Switch `data_storage.get` to return a `ReadableStream` directly, plumb through `DataStorage` interface. |
| Cloudflare R2 | Yes | Already returns `object.body: ReadableStream` — already returned by data client (`cloudflare.ts:382`). No change. |
| Layered | Mixed | Streams from whichever backend the read hit. Current code already returns a `DataHandle`; no change. |

The big gap is the file backend — the `DataStorage` adapter (`backend/base.ts:28-33`) returns `Promise<Uint8Array | null>`, forcing buffering. To make file backend genuinely streaming, `DataStorage.get` must change to return `Promise<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> } | null>` (effectively a `DataHandle`).

That's a breaking change to anyone implementing a custom backend on top of `DataStorage`. See §3.

### 2.5 What `bytes()` returns post-codec

`SnapshotHandle.bytes()` returns the **stored** bytes (post-encode, pre-decode) — i.e. the literal R2/file payload, including any gzip/encrypt layers applied. This is the only sensible answer because the codec is the only thing that knows how to invert the layers, and asking for "raw decoded bytes" before `decode` runs is incoherent for a `Codec<User>` (decoded value isn't bytes).

If a consumer wants "decoded bytes" out of `binary_codec()`, they call `value()` — which returns `Uint8Array` for that codec.

---

## 3. Backwards compatibility

### 3.1 Public API additions (non-breaking)

- `Codec<T>.encode_stream?` / `decode_stream?` — optional, structural. **Custom codec implementations continue to compile.**
- `Store.get_handle` / `get_latest_handle` — new methods, additive.
- `SnapshotHandle<T>` — new exported type.
- `compose`, `BytesCodec` — new exports.
- `gzip_codec()`, `encrypt_codec(key)` — new exports.

### 3.2 Internal changes (BREAKING for custom backends)

**BREAKING: `DataStorage` adapter interface changes.**

`backend/base.ts:28` — `DataStorage.get` signature changes from `Promise<Uint8Array | null>` to `Promise<DataStorageHandle | null>`:

```ts
// new
export type DataStorageHandle = {
  bytes: () => Promise<Uint8Array>
  stream?: () => ReadableStream<Uint8Array>  // optional; falls back to one-chunk wrapper
  size?: number
}
```

This affects anyone who built a custom backend using `create_data_client(storage, emit)`. Memory and file backends in this repo update accordingly — Cloudflare doesn't go through `create_data_client` so it's unaffected.

**Mitigation:** ship a `wrap_bytes_storage(storage: { get: () => Promise<Uint8Array | null>, … }): DataStorage` adapter so existing custom backends migrate with one line (`create_data_client(wrap_bytes_storage(my_storage), emit)`).

Document the change in the changelog. This is `0.4.0` material.

### 3.3 Non-breaking for end-users

Nothing on `Corpus`, `Store.get`, `Store.put`, or any backend factory function (`create_memory_backend`, `create_file_backend`, `create_cloudflare_backend`, `create_layered_backend`) changes signature. Existing consumer code keeps working.

---

## 4. Reference codecs (Phase 4)

### 4.1 `gzip_codec()`

```ts
export function gzip_codec(): BytesCodec {
  return {
    content_type: 'application/gzip',  // wrapper layer — head's content_type wins after compose
    encode(bytes) {
      // sync compress is awkward in web standards; this is the buffered path
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
      return await new Response(stream).arrayBuffer().then(b => new Uint8Array(b))
      // (encode signature is sync — for sync we'd need a Node zlib path; see open question §6)
    },
    decode(bytes) { /* DecompressionStream similarly */ },
    encode_stream(bytesStream) { return bytesStream.pipeThrough(new CompressionStream('gzip')) },
    decode_stream(bytesStream) { return bytesStream.pipeThrough(new DecompressionStream('gzip')) },
  }
}
```

Important note: `Codec<T>.encode` is currently `(value: T) => Uint8Array` (sync). gzip's `CompressionStream` is async. Either:
- Make sync `encode` use Bun's `Bun.gzipSync` / Node's `zlib.gzipSync` (fast but ties us to Bun/Node — won't run in Workers without polyfill).
- Change `Codec.encode` to allow `Promise<Uint8Array>` (BREAKING for the codec interface).

**Decision: change `encode` and `decode` to allow `T | Promise<T>` / `Uint8Array | Promise<Uint8Array>` return types** — this is also additive at the consumer level (callers `await` either way) but is a type-signature change for codec implementers. Treat as a tolerated breaking change in 0.4.0. See §6 (open question).

### 4.2 `encrypt_codec(key)`

AES-GCM via WebCrypto. Encryption is streamable on the encode side trivially (encrypt block-by-block); decryption is **not** safely streamable — AES-GCM authenticates the entire ciphertext via a tag at the end, and yielding plaintext chunks before tag verification leaks unauthenticated data to the consumer.

So:

```ts
export function encrypt_codec(key: CryptoKey): BytesCodec {
  return {
    content_type: 'application/octet-stream',
    encode(bytes) { /* WebCrypto AES-GCM encrypt; prepends 12-byte IV */ },
    decode(bytes) { /* slice IV, decrypt */ },
    encode_stream(bytes) { /* fine — encrypt in chunks then append tag */ },
    // decode_stream INTENTIONALLY omitted: must verify auth tag before yielding plaintext
  }
}
```

Adding `encrypt_codec()` to a composition therefore disables streaming decode for the whole pipeline. That is the correct semantics — caught at the type level via §2.3's structural streamability check. Document this prominently in `api/codecs.mdx`.

---

## 5. Phased implementation

Each phase is independently committable and verifiable. Parallelisation noted per phase.

### Phase 1 — Codec interface evolution + composition

**Scope:**
- Add `encode_stream?` / `decode_stream?` to `Codec<T>` (`types.ts`).
- Change `Codec.encode` / `Codec.decode` to support sync OR async return (see §6 — depends on user decision; default plan is async-allowed).
- Add `BytesCodec` alias.
- Add `compose(...)` to `utils.ts` (or new `codecs/compose.ts`).
- Update `json_codec`, `text_codec`, `binary_codec`:
  - `text_codec` and `binary_codec` get `encode_stream` / `decode_stream` (chunked passthrough).
  - `json_codec` stays decode-only on bytes (no stream methods).
- Unit tests for `compose()` (4–6 tests: composition order, error propagation, streamability inference, non-streamable layer disables stream).

**Files touched:** `types.ts`, `utils.ts`, `tests/unit/compose.test.ts` (new), `tests/unit/codecs.test.ts` (new — covers stream codecs).

**LOC estimate:** ~250 (compose ~80, codec stream methods ~60, tests ~110).

**Parallelisation:** Two sub-tasks can run in parallel in worktrees:
- Worktree A: `compose()` impl + `tests/unit/compose.test.ts`.
- Worktree B: `text_codec` / `binary_codec` stream methods + `tests/unit/codecs.test.ts`.
- Sequential after both: type changes to `Codec<T>` in `types.ts` (foundational; needs to land before either worktree merges cleanly).

So in practice: do the `types.ts` change as a small task first, then parallelise A + B.

**Exit criteria:** `bun test` green. New tests cover: compose order, encode/decode roundtrip, structural streamability check (a unit test that asserts `compose(text_codec(), gzip_codec()).decode_stream` is defined; `compose(json_codec(s), gzip_codec()).decode_stream` is undefined).

### Phase 2 — `DataStorage` interface + streaming read on backends

**Scope:**
- Change `DataStorage.get` to return `Promise<DataStorageHandle | null>` (`backend/base.ts`).
- Add `wrap_bytes_storage(...)` migration helper.
- Update memory backend: still wraps `Uint8Array` in a one-chunk stream, uses `DataStorageHandle`.
- Update file backend: `data_storage.get` returns `{ stream: () => Bun.file(path).stream(), bytes: () => Bun.file(path).arrayBuffer() }`.
- Cloudflare backend: no change (doesn't use `create_data_client`).
- Layered backend: passes through whatever `DataHandle` the inner backend returned.
- Add streaming contract tests to `tests/integration/backend-contract.test.ts`:
  - `data handle stream() returns multi-chunk stream when available` (file backend big-file test → assert chunk count >= 2 by writing a > 64 KB file).
  - `stream() and bytes() return identical content`.
- Update `tests/integration/backend-contract.test.ts` invocations for any custom factory that needs adapting.

**Files touched:** `backend/base.ts`, `backend/memory.ts`, `backend/file.ts`, `backend/layered.ts`, `tests/integration/backend-contract.test.ts`.

**LOC estimate:** ~180.

**Parallelisation:** `backend/base.ts` change is foundational (sequential, single coder). Then memory + file backend updates can run in parallel. Layered test runs after.

**Exit criteria:** existing backend contract suite still passes; new "stream is actually chunked" test passes for file backend with a >64 KB payload.

### Phase 3 — `Store.get_handle` + `SnapshotHandle<T>`

**Scope:**
- Add `SnapshotHandle<T>` to `types.ts`.
- Add `get_handle` and `get_latest_handle` to `Store<T>` interface.
- Implement in `corpus.ts`'s `create_store`:
  - `get_handle` fetches metadata, fetches `DataHandle`, wraps in `SnapshotHandle<T>` that calls `codec.decode` on `value()` and `codec.decode_stream` on `stream()` (if present).
  - `get_latest_handle` similarly.
- Integration tests in `tests/integration/store-streaming.test.ts` (new):
  - put/get_handle roundtrip: `value()`, `bytes()`, `stream()` all return correct content.
  - `stream()` with a streamable codec yields chunks; assert chunk count > 1 with a multi-chunk source.
  - Type-level test (compile-only): `corpus.stores.users.get_handle(v).then(r => r.value.handle.stream())` should be a TS error when `users` uses `json_codec` — verify by reading a `// @ts-expect-error` line.

**Files touched:** `types.ts`, `corpus.ts`, `tests/integration/store-streaming.test.ts` (new).

**LOC estimate:** ~150.

**Parallelisation:** Sequential. Single coder. Depends on Phase 1 + Phase 2.

**Exit criteria:** New store-streaming test green; existing tests untouched.

### Phase 4 — Reference streamable codecs

**Scope:**
- `codecs/gzip.ts`: `gzip_codec()` using `CompressionStream` / `DecompressionStream`.
- `codecs/encrypt.ts`: `encrypt_codec(key: CryptoKey)` using WebCrypto AES-GCM. Intentionally omits `decode_stream` (auth-tag).
- Re-export from `index.ts`.
- Unit tests for each: roundtrip, stream roundtrip (where applicable), wrong-key decrypt fails.
- Integration test: full pipeline `compose(json_codec(Schema), gzip_codec())` storing to memory backend; verify deduplication works on the *encoded* bytes (two identical values produce same content_hash → same data_key).

**Files touched:** `codecs/gzip.ts` (new), `codecs/encrypt.ts` (new), `index.ts`, `tests/unit/gzip-codec.test.ts` (new), `tests/unit/encrypt-codec.test.ts` (new), `tests/integration/composed-codecs.test.ts` (new).

**LOC estimate:** ~280.

**Parallelisation:** gzip and encrypt are fully independent — two parallel worktrees. Integration test runs after both merge.

**Exit criteria:** New tests green. `bun run typecheck` green. Encrypt codec test asserts `decode_stream` is `undefined` (so a compose with encrypt drops streaming).

### Phase 5 — Documentation

**Scope:**
- New page: `docs/src/content/docs/api/streaming.mdx` — explains `SnapshotHandle`, when to use `get_handle` vs `get`, streamability rules.
- Update: `docs/src/content/docs/api/codecs.mdx` — section on composition with `compose()`, list of built-in streamable / non-streamable codecs, the encryption auth-tag note.
- Update: `docs/src/content/docs/api/core/types.mdx` — document `SnapshotHandle<T>`, `BytesCodec`.
- Update: `docs/astro.config.mjs` sidebar — add Streaming page.
- Update: `docs/src/content/docs/api/extending-backends.mdx` — note the `DataStorage.get` signature change and the `wrap_bytes_storage` migration helper.
- Run `bun run docs:build` to regenerate `llms.txt` and catch broken links.
- Update `AGENTS.md` "Gotchas" with: `compose()` streamability rule + `wrap_bytes_storage` migration path.

**Files touched:** `docs/src/content/docs/api/streaming.mdx` (new), `docs/src/content/docs/api/codecs.mdx`, `docs/src/content/docs/api/core/types.mdx`, `docs/src/content/docs/api/extending-backends.mdx`, `docs/astro.config.mjs`.

**LOC estimate:** ~400 (mostly prose).

**Parallelisation:** Streaming MDX, codecs MDX, and extending-backends MDX can run in parallel (3 worktrees). Sequential merge → run `bun run docs:build` once.

**Exit criteria:** `bun run docs:build` succeeds, no broken links.

---

## 6. Open questions

These should be resolved before Phase 1 starts.

1. **`Codec.encode` / `decode` sync vs async.** gzip's `CompressionStream` is async. Either:
   - (a) Allow `Codec.encode` to return `Uint8Array | Promise<Uint8Array>` (and same for `decode`). Tolerated breaking change for codec implementers — they keep returning sync if they can; consumers just `await`. Affects `corpus.ts:68` and `corpus.ts:133` (need an `await` added).
   - (b) Pin `gzip_codec.encode` to a sync zlib path (Bun-only / Node-only) and skip Workers compatibility on the sync API.
   - **Recommendation: (a).** Workers compatibility matters for this library and the cost is one `await`.

2. **`Store.put` accepting a `ReadableStream<T>` for streaming encode.** Out of scope here? Or fold into Phase 3? The `DataClient.put` already accepts a `ReadableStream<Uint8Array>`, so the plumbing for an encode-side streaming path exists. Adding `Store.put_stream(stream: ReadableStream<T>): Promise<…>` would mirror the read side. **Recommendation: defer to a follow-up plan; keep this plan read-focused.**

3. **`DataStorage.get` signature change.** Confirmed BREAKING for custom backends building on `create_data_client`. Are there known external consumers? If yes, the `wrap_bytes_storage` helper is enough. If we want zero breakage, we'd add a parallel `create_streaming_data_client` and leave the old one alone — extra surface area for marginal benefit. **Recommendation: take the break, ship the wrap helper.**

4. **Should `compose()` allow more than one head codec (e.g. `compose(json, msgpack_layer, gzip)`)?** No — keeping it as "one head + N byte transforms" keeps types tractable. If someone needs `Codec<A> → Codec<B>` mid-chain (rare; e.g. base64-encode-as-string), they wrap manually. Decision baked into §2.3.

5. **Hash content addressing on composed codecs.** Today the content_hash is computed on the encoded bytes. With encryption, two identical inputs produce different ciphertexts (because of random IV) → no deduplication. This is correct security behaviour but worth documenting. Should we offer an opt-in deterministic encryption mode (zero IV / nonce-derived)? **Recommendation: no — security footgun. Document the tradeoff in `api/codecs.mdx` and move on.**

---

## 7. Testing strategy summary

### New test files

| File | Type | Coverage |
|---|---|---|
| `tests/unit/compose.test.ts` | Unit | composition order, error propagation, streamability inference |
| `tests/unit/codecs.test.ts` | Unit | stream encode/decode for `text_codec` and `binary_codec` |
| `tests/unit/gzip-codec.test.ts` | Unit | roundtrip; stream roundtrip; bad-bytes decode error |
| `tests/unit/encrypt-codec.test.ts` | Unit | roundtrip; wrong key fails; `decode_stream` is undefined |
| `tests/integration/store-streaming.test.ts` | Integration | `get_handle` workflow on memory + file backends; chunk count > 1 assertion |
| `tests/integration/composed-codecs.test.ts` | Integration | `compose(json, gzip)` end-to-end through memory backend; deduplication still works |

### Additions to `backend-contract.test.ts`

- `data handle stream() returns multi-chunk stream` — write 256 KB, assert reader yields > 1 chunk on file backend, exactly 1 on memory.
- `stream() and bytes() return identical content` — already partially covered (`backend-contract.test.ts:387-414`); strengthen to compare `stream()` output with `bytes()`.

### How we test "actually streams"

Two strategies:

1. **Chunk count assertion:** read the stream, count chunks. For a 256 KB payload through `Bun.file().stream()`, expect ≥ 2 chunks. This is the simplest "didn't accidentally buffer" check.
2. **First-byte timing:** read the first chunk, assert it arrives before the writer signals "done". Skipped for now — flaky in CI, low value over (1).

### Type-level tests

Use `// @ts-expect-error` lines to assert that:
- `corpus.stores.users.get_handle(v).then(r => r.value.handle.stream())` is a type error when `users` uses `json_codec` (which lacks `decode_stream`).
- `compose(json_codec(s), gzip_codec()).decode_stream` is not callable (`undefined` at the value level, also reflected in inferred type via conditional type on the return).

---

## 8. devpad tasks (proposed; do not create yet)

Tasks to mirror in devpad once the plan is approved. Format: `[priority] title — description`.

### Phase 1 — Codec interface + compose

- `[high] Add streaming methods to Codec<T> interface` — extend `types.ts` with optional `encode_stream` / `decode_stream`; allow `encode`/`decode` to return promises. Foundation for everything else.
- `[high] Implement compose() operator` — variadic `compose(head, ...layers)` in `utils.ts`; structural streamability inference.
- `[medium] Add streaming to text_codec / binary_codec` — `encode_stream` / `decode_stream` on the two chunkable built-ins.
- `[medium] Unit tests for compose() and stream codecs` — coverage per §7.

### Phase 2 — DataStorage streaming

- `[high] BREAKING: DataStorage.get returns DataStorageHandle` — change `backend/base.ts` adapter contract; ship `wrap_bytes_storage` migration helper.
- `[high] File backend streams via Bun.file().stream()` — replace `arrayBuffer()` path with stream path.
- `[medium] Memory backend conforms to new DataStorageHandle` — wrap bytes in one-chunk stream.
- `[medium] Backend contract: streaming chunk-count test` — extend `backend-contract.test.ts` with multi-chunk assertion.

### Phase 3 — SnapshotHandle + get_handle

- `[high] Add SnapshotHandle<T> type` — `types.ts`; conditional `stream` field.
- `[high] Implement Store.get_handle / get_latest_handle` — `corpus.ts`.
- `[medium] Integration tests for streaming reads` — `tests/integration/store-streaming.test.ts`.

### Phase 4 — Reference codecs

- `[medium] gzip_codec() via CompressionStream` — `codecs/gzip.ts`.
- `[medium] encrypt_codec(key) via WebCrypto AES-GCM` — `codecs/encrypt.ts`; intentionally no `decode_stream`.
- `[low] Re-export new codecs from index.ts` — barrel update.
- `[medium] Composed-codec integration test` — `compose(json, gzip)` end-to-end through memory backend.

### Phase 5 — Docs

- `[medium] New docs page: api/streaming.mdx` — `SnapshotHandle`, `get_handle`, streamability rules.
- `[medium] Update api/codecs.mdx with compose() + built-in streamability table` — encryption auth-tag note included.
- `[low] Update api/extending-backends.mdx with DataStorageHandle migration` — wrap_bytes_storage example.
- `[low] Update sidebar in docs/astro.config.mjs` — add Streaming page.
- `[low] Run docs:build to regenerate llms.txt` — verification step.

---

## 9. Suggested AGENTS.md updates

To capture after implementation lands:

### Add to "Conventions"

> **Codecs** — `Codec<T>` exposes optional `encode_stream` / `decode_stream`. A codec without `decode_stream` cannot be used through `Store.get_handle().handle.stream()` — TypeScript enforces this via a conditional type. When writing a new byte-transformer codec (gzip, encrypt, base64), prefer to ship both `encode_stream` and `decode_stream` unless the format fundamentally can't (auth-tagged AEAD on decode, schema-validated formats like Zod-backed JSON).

### Add to "Gotchas"

> - `compose(head, ...layers)` returns a `Codec<T>` whose `decode_stream` is only defined when every layer (head + all wrappers) has `decode_stream`. Dropping `encrypt_codec()` into a composition disables streaming reads — by design, because AES-GCM requires the auth tag before any plaintext is safe to release.
> - `DataStorage.get` returns a `DataStorageHandle`, not raw bytes (changed in 0.4.0). Custom backends should call `wrap_bytes_storage(...)` if they only have a bytes-returning getter.
