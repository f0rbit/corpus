# corpus

a functional snapshotting library for typescript. store versioned data with lineage tracking, content deduplication, and multiple backend support (memory, file, cloudflare d1/r2).

## install

```bash
bun add @f0rbit/corpus
```

## usage

```typescript
import { z } from "zod";
import { create_corpus, create_memory_backend, define_store, json_codec } from "@f0rbit/corpus";

const TimelineSchema = z.object({
	items: z.array(z.object({ id: z.string(), text: z.string() })),
});

const corpus = create_corpus()
	.with_backend(create_memory_backend())
	.with_store(define_store("timelines", json_codec(TimelineSchema)))
	.build();

// typed store access - version is auto-generated
const result = await corpus.stores.timelines.put({
	items: [{ id: "1", text: "hello" }],
});

if (result.ok) {
	console.log("saved:", result.value.content_hash);
}
```

## for package authors

If you're building a package with types you want to test via property-based testing, add a testing registrar to vend arbitraries and failure cases. See [`docs/templates/testing/register.ts`](docs/templates/testing/register.ts) for a copy-paste template with full comments, and the [testing documentation](docs/src/content/docs/testing/) for the full substrate reference.

## todo

- [ ] add gzip compression codec wrapper for large json blobs
- [ ] add encryption codec wrapper for sensitive data at rest
- [ ] implement ttl/expiration support with auto-cleanup
- [ ] add batch operations (put_many, get_many) for bulk imports
- [ ] create drizzle migration files for d1 schema setup
- [ ] add diff(v1, v2) function for comparing json snapshots
- [ ] implement data compaction (merge old versions)
- [ ] add rate limiting awareness for cloudflare api limits
- [ ] add signed url support for direct r2 access to large files
- [ ] implement garbage collection for orphaned data blobs (especially r2 objects orphaned by aborted cross-store transactions — see `.plans/cross-store-atomic.md`)
- [ ] add retry logic with exponential backoff for network failures
- [ ] graduation: `f0rbit/no-ambient-effects` warns (32, @f0rbit/lint 0.3.0) — `generate_version`/`generate_observation_id`'s clock/rng reads and `corpus.ts`/`observations/storage.ts`'s inline `new Date()` timestamps sit in general-purpose modules, not dedicated provider files, so `ambient_effect_files` would over-suppress; revisit as a real clock/rng-injection refactor if it becomes a testing pain point (see the backend-equivalence suite's existing Date-precision special-casing)
- [ ] graduation: `f0rbit/prefer-pipe` warns (7, @f0rbit/lint 0.3.0) — all inside `corpus.transaction(async (tx) => ...)` test bodies that thread 2-3 prior Result values into a later step; `pipe()`'s single-threaded chain doesn't compose cleanly for that shape without nesting. Revisit if result.ts grows a multi-value combinator
