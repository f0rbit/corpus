# Corpus Documentation Gap Analysis

**Date:** 2026-01-18  
**Analyst:** Principal Software Architect  
**Library Version:** 0.3.3

## Executive Summary

The `@f0rbit/corpus` documentation is comprehensive for core use cases (getting started, backends, observations). However, several APIs and features in the source code are either undocumented or under-documented. This analysis identifies **32 specific gaps** organized by priority, with actionable recommendations for each.

### Documentation Inventory

| Category | Source Files | Doc Pages | Coverage |
|----------|-------------|-----------|----------|
| Core (corpus, types) | 2 | 5 | ~85% |
| Backends | 5 | 4 | ~90% |
| Codecs | 1 | 1 | ~95% |
| Result Utilities | 1 | 1 | ~95% |
| Concurrency | 1 | 1 (partial) | ~80% |
| Observations | 6 | 2 | ~75% |
| SST Integration | 1 | 0.5 (in cloudflare guide) | ~40% |
| Schema (Drizzle) | 2 | 0 | ~10% |
| Pointer Utilities | 1 | 0.5 (in observations) | ~50% |

---

## High Priority Gaps

These are critical missing pieces that users likely need.

### 1. Missing: Drizzle Schema Documentation

**Source:** `schema.ts`, `observations/schema.ts`  
**Exports:** `corpus_snapshots`, `corpus_observations`, `CorpusSnapshotRow`, `CorpusSnapshotInsert`, `ObservationRow`, `ObservationInsert`

**Gap:** No dedicated documentation for users who want to:
- Query the database directly with Drizzle
- Understand the table structure for custom queries
- Build extensions on top of the schema

**Recommendation:** Create `/api/schema.mdx` covering:
- `corpus_snapshots` table structure and indexes
- `corpus_observations` table structure and indexes
- Type exports for custom queries
- Example: querying snapshots directly with Drizzle
- Example: joining observations with external tables

**Estimated Effort:** 1-2 hours (~200 lines)

---

### 2. Missing: `CORPUS_MIGRATION_SQL` Full Documentation

**Source:** `sst.ts`  
**Export:** `CORPUS_MIGRATION_SQL`

**Gap:** The Cloudflare guide mentions it briefly, but doesn't show the full SQL or explain:
- When to use programmatic migration vs file-based
- How to verify migration success
- Idempotency guarantees (IF NOT EXISTS)
- Observations table creation (recently added)

**Recommendation:** Add a dedicated "Database Migrations" section to the Cloudflare guide OR create `/guides/migrations.mdx` covering:
- Full migration SQL reference
- Programmatic execution: `await env.D1.exec(CORPUS_MIGRATION_SQL)`
- File-based migration workflow
- Verifying table creation
- Future migration strategy (versioned migrations)

**Estimated Effort:** 1 hour (~100 lines)

---

### 3. Missing: Pointer Utilities API Reference

**Source:** `observations/utils.ts`  
**Exports:** `create_pointer`, `pointer_to_key`, `key_to_pointer`, `resolve_path`, `apply_span`, `generate_observation_id`, `pointers_equal`, `pointer_to_snapshot`

**Gap:** These utilities are mentioned in the observations guide but lack dedicated API documentation. Users building complex observation workflows need to understand:
- JSONPath syntax supported by `resolve_path`
- Key format for `pointer_to_key` (useful for caching)
- Error handling for `apply_span`

**Recommendation:** Create `/api/core/pointers.mdx` or add a "Pointer Utilities" section to the observations API page covering:
- `create_pointer()` - full signature and examples
- `resolve_path()` - supported JSONPath syntax
- `apply_span()` - error cases
- `pointer_to_key()` / `key_to_pointer()` - for Map storage
- `pointers_equal()` - comparison utility
- `pointer_to_snapshot()` - strip path/span

**Estimated Effort:** 1.5 hours (~150 lines)

---

### 4. Missing: `define_store` Advanced Options

**Source:** `types.ts` (lines 356-414)  
**Gap:** The `define_store` function accepts optional `data_key_fn` for custom storage paths, but this is not documented.

```typescript
const hansard = define_store('hansard', text_codec(), {
  data_key_fn: (ctx) => {
    const date = ctx.tags?.find(t => t.startsWith('date:'))?.slice(5) ?? 'unknown'
    return `australia-house/raw/${date}/${ctx.version}`
  }
})
```

**Recommendation:** Add to `/api/core/define-store.mdx`:
- `DefineStoreOpts` type definition
- `DataKeyContext` type definition
- Example: organizing data by date tags
- Example: custom namespace prefixes
- When to use vs default behavior

**Estimated Effort:** 30 minutes (~50 lines)

---

### 5. Missing: LLM Context Page (`llms.txt`)

**Gap:** No `llms.txt` or similar file exists for LLM code assistants to understand the library.

**Recommendation:** Create `/public/llms.txt` (or similar) containing:
- Library purpose and core concepts
- Key exports and their purposes
- Common patterns (create_corpus builder, Result handling)
- Error handling conventions
- Import paths (`@f0rbit/corpus` vs `@f0rbit/corpus/cloudflare`)

**Estimated Effort:** 1 hour (~200 lines)

---

### 6. Missing: `createCorpusInfra` SST Helper Documentation

**Source:** `sst.ts`  
**Exports:** `createCorpusInfra`, `CorpusInfra`, `CorpusInfraConfig`

**Gap:** Only briefly mentioned in the Cloudflare guide. Users with SST need:
- Full API reference
- Configuration options
- Integration with SST v3 patterns
- Example `sst.config.ts`

**Recommendation:** Create `/guides/sst.mdx` OR expand the SST section in cloudflare.mdx:
- `createCorpusInfra()` signature
- `CorpusInfraConfig` options
- Complete SST v3 example
- Linking resources to workers

**Estimated Effort:** 45 minutes (~80 lines)

---

## Medium Priority Gaps

These would be helpful additions that improve the developer experience.

### 7. Missing: VersionFilter Documentation

**Source:** `observations/types.ts` (lines 130-155)  
**Export:** `VersionFilter` type

**Gap:** The `version_filter` option in `ObservationQueryOpts` is typed but not documented. This is powerful for filtering observations to published/active versions.

```typescript
// Filter to only published versions
const publishedVersions = new Set(['v1', 'v2', 'v3'])
for await (const obs of corpus.observations.query({
  version_filter: publishedVersions
})) {
  // Only observations from published versions
}
```

**Recommendation:** Add to observations API/guide:
- `VersionFilter` type definition
- Example: Set-based filtering
- Example: Array-based filtering
- Example: Async function filtering (check database)

**Estimated Effort:** 30 minutes (~40 lines)

---

### 8. Missing: `InferObservationContent` Utility Type

**Source:** `observations/types.ts`  
**Export:** `InferObservationContent<T>`

**Gap:** Listed in API reference but no practical example of when to use it.

**Recommendation:** Add example to observations API:
```typescript
const entity_mention = define_observation_type('entity_mention', EntitySchema)
type EntityMention = InferObservationContent<typeof entity_mention>

// Use in function signatures
function processEntity(content: EntityMention) { ... }
```

**Estimated Effort:** 15 minutes (~20 lines)

---

### 9. Missing: ObservationsStorage Adapter Interface

**Source:** `observations/storage.ts`  
**Exports:** `ObservationsStorage`, `ObservationsAdapter`, `create_observations_storage`

**Gap:** For users implementing custom backends with observations support, there's no documentation on:
- `ObservationsAdapter` interface (base + optimized operations)
- How `create_observations_storage()` wraps adapters
- Migration from deprecated `ObservationsCRUD`

**Recommendation:** Add to backends types page or create `/api/extending-backends.mdx`:
- `ObservationsAdapter` interface
- Base vs optimized operations
- Example: wrapping a PostgreSQL implementation
- `create_observations_storage()` usage

**Estimated Effort:** 1 hour (~100 lines)

---

### 10. Missing: Event System Deep Dive

**Source:** `types.ts` (lines 107-119)  
**Types:** `CorpusEvent`, `EventHandler`

**Gap:** Event types are documented in backends/types.mdx but lack:
- Complete event type reference table
- Event timing (when each fires)
- Use cases (metrics, debugging, audit logging)
- `deduplicated` flag explanation

**Recommendation:** Create `/guides/events-and-observability.mdx` OR expand backends guide:
- Full event type table with descriptions
- Practical examples: metrics collection
- Practical examples: request tracing
- Practical examples: debugging

**Estimated Effort:** 45 minutes (~80 lines)

---

### 11. Missing: Concurrency Utilities in Navigation

**Source:** `concurrency.ts`  
**Exports:** `Semaphore`, `parallel_map`

**Gap:** These are documented in utilities.mdx but:
- Not in the sidebar navigation
- Not discoverable from the API index
- No standalone page

**Recommendation:** Either:
- Add "Concurrency" section link in sidebar
- OR create `/api/concurrency.mdx` with full examples

**Estimated Effort:** 30 minutes (~60 lines if new page)

---

### 12. Missing: Stream Utilities

**Source:** `utils.ts` (lines 189-220)  
**Exports:** `concat_bytes`, `stream_to_bytes`, `to_bytes`

**Gap:** Internal utilities that could be useful for custom codec implementations.

**Recommendation:** Add to utilities page or codecs page:
- `concat_bytes()` - combine Uint8Array chunks
- `stream_to_bytes()` - consume stream to bytes
- `to_bytes()` - normalize stream or bytes to bytes

**Estimated Effort:** 20 minutes (~30 lines)

---

### 13. Missing: Filter Pipeline Utilities

**Source:** `utils.ts` (lines 229-301)  
**Exports:** `create_filter_pipeline`, `FilterPipelineConfig`

**Gap:** Powerful utility for building type-safe filtering, but undocumented. Users building custom queries could reuse this.

**Recommendation:** Add to utilities page:
- `create_filter_pipeline()` signature
- `FilterPipelineConfig` type
- Example: custom entity filter

**Estimated Effort:** 30 minutes (~40 lines)

---

### 14. Missing: `parse_snapshot_meta` Utility

**Source:** `utils.ts` (lines 307-337)  
**Export:** `parse_snapshot_meta`

**Gap:** Useful for users parsing raw database rows or JSON files.

**Recommendation:** Add to utilities page:
- When to use (parsing D1 rows, JSON files)
- Input/output types
- Date string handling

**Estimated Effort:** 15 minutes (~20 lines)

---

### 15. Incomplete: Corpus Instance Properties

**Source:** `types.ts` (lines 426-434), `corpus.ts` (lines 302-310)  
**Gap:** The `Corpus` type includes:
- `observations?: ObservationsClient` - documented
- `create_pointer` - mentioned but not documented as corpus method
- `resolve_pointer` - mentioned but not documented as corpus method
- `is_superseded` - mentioned but not documented as corpus method

**Recommendation:** Add to create-corpus.mdx or types.mdx:
- Full `Corpus<Stores>` type definition
- `corpus.create_pointer()` method
- `corpus.resolve_pointer()` method
- `corpus.is_superseded()` method

**Estimated Effort:** 30 minutes (~50 lines)

---

### 16. Missing: Observation Query `include_stale` Behavior

**Source:** `observations/client.ts`, `observations/types.ts`

**Gap:** The guide mentions `include_stale: true` but:
- Not in the ObservationQueryOpts type docs (line 377)
- No explanation of default behavior
- Staleness detection algorithm not explained

**Recommendation:** Add to observations API:
- Default: false (exclude stale)
- How staleness is determined (compare to latest version)
- When to use `include_stale: true`

**Estimated Effort:** 15 minutes (~20 lines)

---

## Low Priority Gaps

Nice-to-have improvements.

### 17. Missing: Recipes/Cookbook Section

**Gap:** No practical recipes for common patterns like:
- Document versioning with approval workflow
- Caching API responses
- Audit log implementation
- Multi-tenant data isolation

**Recommendation:** Create `/guides/recipes.mdx` with 4-6 practical examples.

**Estimated Effort:** 2-3 hours

---

### 18. Missing: Performance Tuning Guide

**Gap:** No guidance on:
- When to use layered backends
- Memory usage considerations
- D1/R2 cost optimization
- Batch processing patterns

**Recommendation:** Create `/guides/performance.mdx`

**Estimated Effort:** 1.5 hours

---

### 19. Missing: Changelog

**Gap:** No visible changelog documenting version history.

**Recommendation:** Create `/changelog.mdx` or link to GitHub releases.

**Estimated Effort:** 30 minutes (ongoing)

---

### 20. Missing: FAQ Page

**Gap:** Common questions scattered across docs:
- "Do I need Zod?" (appears in codecs)
- "Can I use with Node.js?" (appears in file backend)
- "How does deduplication work?" (appears in multiple places)

**Recommendation:** Create `/faq.mdx` with common questions consolidated.

**Estimated Effort:** 1 hour

---

### 21. Missing: TypeScript Best Practices

**Gap:** No guidance on:
- Type inference patterns
- Generic constraints
- Working with `Result<T, E>` in strict mode

**Recommendation:** Add to getting-started or create `/guides/typescript.mdx`

**Estimated Effort:** 45 minutes

---

### 22. Inconsistent: Package Name in Docs vs README

**Gap:** 
- README uses `corpus` as package name
- Docs use `@f0rbit/corpus`

**Recommendation:** Update README to use `@f0rbit/corpus` consistently.

**Estimated Effort:** 5 minutes

---

### 23. Missing: API Index/Overview Page

**Gap:** No `/api/index.mdx` that shows all exports at a glance.

**Recommendation:** Create API overview page with categorized export list.

**Estimated Effort:** 30 minutes

---

### 24. Missing: `compute_hash` Documentation

**Source:** `utils.ts`  
**Export:** `compute_hash`

**Gap:** Exported but not documented. Useful for users who want to pre-compute hashes.

**Recommendation:** Add to utilities page:
- SHA-256 algorithm
- Return format (lowercase hex)
- Use case: pre-check for duplicates

**Estimated Effort:** 10 minutes

---

### 25. Missing: `generate_version` Documentation

**Source:** `utils.ts`  
**Export:** `generate_version`

**Gap:** Exported but not documented. Users may want to understand version format.

**Recommendation:** Add to utilities page:
- Base64url timestamp format
- Sequence suffix for sub-millisecond
- Lexicographic sorting guarantee

**Estimated Effort:** 15 minutes

---

### 26. Missing: Error Type Completeness

**Source:** `types.ts` (lines 44-54)

**Gap:** `CorpusError` includes types not documented in types.mdx:
- `validation_error` (for observations)
- `observation_not_found`

**Recommendation:** Update types.mdx to include all error kinds.

**Estimated Effort:** 10 minutes

---

### 27. Missing: Backend Base Abstractions

**Source:** `backend/base.ts`  
**Exports:** `MetadataStorage`, `DataStorage`, `create_metadata_client`, `create_data_client`

**Gap:** For users implementing custom backends, these simplify implementation significantly.

**Recommendation:** Add to extending-backends guide or backends types page.

**Estimated Effort:** 30 minutes

---

### 28. Missing: Testing Helpers (from TODO)

**Source:** README.md TODO list

**Gap:** README mentions planned `create_test_corpus`, `seed_test_data` helpers.

**Recommendation:** 
- If implemented: document in testing guide
- If not: remove from TODO or mark as "planned"

**Estimated Effort:** N/A (depends on implementation)

---

### 29. Missing: Entry Points Documentation

**Source:** `package.json` exports

**Gap:** Multiple entry points not clearly documented:
- `@f0rbit/corpus` - full package
- `@f0rbit/corpus/file` - file backend only
- `@f0rbit/corpus/cloudflare` - cloudflare backend only
- `@f0rbit/corpus/types` - types only
- `@f0rbit/corpus/schema` - Drizzle schemas only

**Recommendation:** Add "Import Paths" section to getting-started.

**Estimated Effort:** 20 minutes

---

### 30. Missing: Observations File Storage Details

**Gap:** File backend stores observations in `_observations.json` but this isn't documented. Users inspecting files would benefit from knowing:
- File location
- Format (JSON array of rows)
- Considerations for large observation counts

**Recommendation:** Add to file backend docs.

**Estimated Effort:** 10 minutes

---

### 31. Missing: ListOpts `cursor` Pagination

**Source:** `types.ts` (lines 205-211)

**Gap:** `cursor` is in ListOpts type but:
- No example of cursor-based pagination
- Not implemented in all backends (memory/file don't use it)
- Should clarify backend support

**Recommendation:** Add pagination example to store API docs, note backend support.

**Estimated Effort:** 20 minutes

---

### 32. Missing: `derived_from` Provenance Chain Guide

**Source:** Observations types

**Gap:** `derived_from` field is documented but no practical example of:
- Multi-hop derivation tracking
- Querying provenance graphs
- Use case: AI pipeline provenance

**Recommendation:** Add section to observations guide with pipeline example.

**Estimated Effort:** 30 minutes

---

## Documentation Quality Issues

### Navigation Structure

The current sidebar structure is good but could be improved:
- Add "Concurrency" under API
- Add "Schema" under API  
- Consider "Extending" section for custom backends/codecs

### Cross-Linking

Some pages lack "See Also" sections:
- utilities.mdx -> link to specific Result patterns
- codecs.mdx -> link to custom codec extending

### Code Examples

Most examples are good. Consider adding:
- More error handling examples
- Async iterator consumption patterns
- Real-world schema examples (not just `{ name: string }`)

---

## Implementation Priority Matrix

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Drizzle Schema Docs | 2h | High |
| P0 | LLM Context (llms.txt) | 1h | High |
| P0 | define_store Advanced Options | 30m | High |
| P1 | Pointer Utilities API | 1.5h | Medium |
| P1 | Full Migration SQL Docs | 1h | Medium |
| P1 | SST Helper Docs | 45m | Medium |
| P1 | VersionFilter Docs | 30m | Medium |
| P2 | ObservationsStorage Interface | 1h | Medium |
| P2 | Events Deep Dive | 45m | Low |
| P2 | Concurrency Standalone Page | 30m | Low |
| P3 | Recipes/Cookbook | 3h | Medium |
| P3 | Performance Guide | 1.5h | Low |
| P3 | API Index Page | 30m | Low |

---

## Recommended Action Plan

### Phase 1: Critical Gaps (Week 1)
1. Create `/api/schema.mdx` - Drizzle schema documentation
2. Create `/public/llms.txt` - LLM context
3. Update `/api/core/define-store.mdx` - Add advanced options
4. Fix README package name inconsistency

### Phase 2: Important Gaps (Week 2)
5. Create `/api/core/pointers.mdx` - Pointer utilities
6. Expand Cloudflare guide with full migration docs
7. Expand or create SST guide
8. Add VersionFilter to observations docs
9. Update types.mdx with missing error kinds

### Phase 3: Polish (Week 3+)
10. Create `/api/concurrency.mdx`
11. Add events/observability section
12. Create API index page
13. Add recipes section
14. Create FAQ page

---

## Appendix: Export Inventory

All exports from `index.ts` and their documentation status:

| Export | Category | Documented | Gap |
|--------|----------|------------|-----|
| `create_corpus` | Core | Yes | - |
| `create_store` | Core | Yes | - |
| `define_store` | Core | Partial | data_key_fn missing |
| `ok` | Result | Yes | - |
| `err` | Result | Yes | - |
| `create_memory_backend` | Backend | Yes | - |
| `create_file_backend` | Backend | Yes | - |
| `create_cloudflare_backend` | Backend | Yes | - |
| `create_layered_backend` | Backend | Yes | - |
| `json_codec` | Codec | Yes | - |
| `text_codec` | Codec | Yes | - |
| `binary_codec` | Codec | Yes | - |
| `compute_hash` | Utility | No | Needs docs |
| `generate_version` | Utility | No | Needs docs |
| `corpus_snapshots` | Schema | No | Needs docs |
| `corpus_observations` | Schema | No | Needs docs |
| `match` | Result | Yes | - |
| `unwrap_or` | Result | Yes | - |
| `unwrap` | Result | Yes | - |
| `unwrap_err` | Result | Yes | - |
| `try_catch` | Result | Yes | - |
| `try_catch_async` | Result | Yes | - |
| `fetch_result` | Result | Yes | - |
| `pipe` | Result | Yes | - |
| `to_nullable` | Result | Yes | - |
| `to_fallback` | Result | Yes | - |
| `null_on` | Result | Yes | - |
| `fallback_on` | Result | Yes | - |
| `format_error` | Result | Yes | - |
| `at` | Result | Yes | - |
| `first` | Result | Yes | - |
| `last` | Result | Yes | - |
| `merge_deep` | Result | Yes | - |
| `Semaphore` | Concurrency | Yes | Needs nav |
| `parallel_map` | Concurrency | Yes | Needs nav |
| `define_observation_type` | Observations | Yes | - |
| `create_pointer` | Observations | Partial | Needs API page |
| `pointer_to_key` | Observations | No | Needs docs |
| `key_to_pointer` | Observations | No | Needs docs |
| `resolve_path` | Observations | No | Needs docs |
| `apply_span` | Observations | No | Needs docs |
| `pointers_equal` | Observations | No | Needs docs |
| `pointer_to_snapshot` | Observations | No | Needs docs |
| `generate_observation_id` | Observations | No | Needs docs |
| `createCorpusInfra` | SST | Partial | Needs full docs |
| `CORPUS_MIGRATION_SQL` | SST | Partial | Needs full docs |

**Coverage Summary:**
- Fully documented: 32 exports (~68%)
- Partially documented: 6 exports (~13%)  
- Undocumented: 9 exports (~19%)
