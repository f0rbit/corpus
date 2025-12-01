# corpus

a functional snapshotting library for typescript. store versioned data with lineage tracking, content deduplication, and multiple backend support (memory, file, cloudflare d1/r2).

## install

```bash
bun add corpus
```

## usage

```typescript
import { z } from 'zod'
import { create_corpus, create_memory_backend, define_store, json_codec } from 'corpus'

const TimelineSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
})

const corpus = create_corpus()
  .with_backend(create_memory_backend())
  .with_store(define_store('timelines', json_codec(TimelineSchema)))
  .build()

// typed store access - version is auto-generated
const result = await corpus.stores.timelines.put({ 
  items: [{ id: '1', text: 'hello' }] 
})

if (result.ok) {
  console.log('saved:', result.value.content_hash)
}
```

## todo

- [ ] add gzip compression codec wrapper for large json blobs
- [ ] add encryption codec wrapper for sensitive data at rest
- [ ] implement ttl/expiration support with auto-cleanup
- [ ] add batch operations (put_many, get_many) for bulk imports
- [ ] create drizzle migration files for d1 schema setup
- [ ] add diff(v1, v2) function for comparing json snapshots
- [ ] implement data compaction (merge old versions)
- [ ] add rate limiting awareness for cloudflare api limits
- [ ] create test utilities module with helpers (create_test_corpus, seed_test_data)
- [ ] add signed url support for direct r2 access to large files
- [ ] implement garbage collection for orphaned data blobs
- [ ] add retry logic with exponential backoff for network failures
