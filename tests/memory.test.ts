import { describe, it, expect, beforeEach } from 'bun:test'
import { z } from 'zod'
import {
  create_corpus,
  create_memory_backend,
  define_store,
  json_codec,
  type CorpusEvent,
  type Corpus,
  type Store,
} from '../index'

const ItemSchema = z.object({
  id: z.string(),
  text: z.string(),
})

const TimelineSchema = z.object({
  items: z.array(ItemSchema),
  cursor: z.string().optional(),
})

type Timeline = z.infer<typeof TimelineSchema>

describe('memory backend', () => {
  let events: CorpusEvent[]
  let corpus: Corpus<{ timelines: Store<Timeline> }>

  beforeEach(() => {
    events = []
    corpus = create_corpus()
      .with_backend(create_memory_backend({ on_event: (e) => events.push(e) }))
      .with_store(define_store('timelines', json_codec(TimelineSchema)))
      .build()
  })

  describe('basic crud', () => {
    it('puts and gets a snapshot', async () => {
      const data: Timeline = { items: [{ id: '1', text: 'hello' }] }
      
      const put_result = await corpus.stores.timelines.put('v1', data)
      expect(put_result.ok).toBe(true)
      if (!put_result.ok) return
      
      expect(put_result.value.store_id).toBe('timelines')
      expect(put_result.value.version).toBe('v1')
      expect(put_result.value.content_hash).toBeString()
      
      const get_result = await corpus.stores.timelines.get('v1')
      expect(get_result.ok).toBe(true)
      if (!get_result.ok) return
      
      expect(get_result.value.data).toEqual(data)
      expect(get_result.value.meta.version).toBe('v1')
    })

    it('returns not_found for missing version', async () => {
      const result = await corpus.stores.timelines.get('nonexistent')
      
      expect(result.ok).toBe(false)
      if (result.ok) return
      
      expect(result.error.kind).toBe('not_found')
      expect(result.error.store_id).toBe('timelines')
      expect(result.error.version).toBe('nonexistent')
    })

    it('deletes a snapshot', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      
      const delete_result = await corpus.stores.timelines.delete('v1')
      expect(delete_result.ok).toBe(true)
      
      const get_result = await corpus.stores.timelines.get('v1')
      expect(get_result.ok).toBe(false)
    })

    it('returns not_found when deleting non-existent', async () => {
      const result = await corpus.stores.timelines.delete('nonexistent')
      
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_found')
    })

    it('get_latest returns most recent by created_at', async () => {
      await corpus.stores.timelines.put('v1', { items: [{ id: '1', text: 'first' }] })
      await new Promise(r => setTimeout(r, 5))
      await corpus.stores.timelines.put('v2', { items: [{ id: '2', text: 'second' }] })
      await new Promise(r => setTimeout(r, 5))
      await corpus.stores.timelines.put('v3', { items: [{ id: '3', text: 'third' }] })
      
      const result = await corpus.stores.timelines.get_latest()
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.meta.version).toBe('v3')
      expect(result.value.data.items[0].text).toBe('third')
    })

    it('get_latest returns not_found on empty store', async () => {
      const result = await corpus.stores.timelines.get_latest()
      
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_found')
    })

    it('list returns all snapshots newest first', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      await new Promise(r => setTimeout(r, 5))
      await corpus.stores.timelines.put('v2', { items: [] })
      await new Promise(r => setTimeout(r, 5))
      await corpus.stores.timelines.put('v3', { items: [] })
      
      const versions: string[] = []
      for await (const meta of corpus.stores.timelines.list()) {
        versions.push(meta.version)
      }
      
      expect(versions).toHaveLength(3)
      expect(versions[0]).toBe('v3')
      expect(versions[2]).toBe('v1')
    })

    it('get_meta returns only metadata without data', async () => {
      await corpus.stores.timelines.put('v1', { items: [{ id: '1', text: 'test' }] })
      
      const result = await corpus.stores.timelines.get_meta('v1')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.version).toBe('v1')
      expect(result.value.content_hash).toBeString()
      expect((result.value as any).data).toBeUndefined()
    })
  })

  describe('deduplication', () => {
    it('reuses data_key for identical content', async () => {
      const data: Timeline = { items: [{ id: '1', text: 'same' }] }
      
      const result1 = await corpus.stores.timelines.put('v1', data)
      const result2 = await corpus.stores.timelines.put('v2', data)
      
      expect(result1.ok && result2.ok).toBe(true)
      if (!result1.ok || !result2.ok) return
      
      expect(result1.value.content_hash).toBe(result2.value.content_hash)
      expect(result1.value.data_key).toBe(result2.value.data_key)
    })

    it('uses different data_key for different content', async () => {
      const result1 = await corpus.stores.timelines.put('v1', { items: [{ id: '1', text: 'a' }] })
      const result2 = await corpus.stores.timelines.put('v2', { items: [{ id: '2', text: 'b' }] })
      
      expect(result1.ok && result2.ok).toBe(true)
      if (!result1.ok || !result2.ok) return
      
      expect(result1.value.content_hash).not.toBe(result2.value.content_hash)
      expect(result1.value.data_key).not.toBe(result2.value.data_key)
    })

    it('emits deduplicated event on second put', async () => {
      const data: Timeline = { items: [] }
      
      await corpus.stores.timelines.put('v1', data)
      await corpus.stores.timelines.put('v2', data)
      
      const data_puts = events.filter(e => e.type === 'data_put') as Array<Extract<CorpusEvent, { type: 'data_put' }>>
      
      expect(data_puts).toHaveLength(2)
      expect(data_puts[0].deduplicated).toBe(false)
      expect(data_puts[1].deduplicated).toBe(true)
    })
  })

  describe('lineage tracking', () => {
    it('stores parents on put', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      
      const result = await corpus.stores.timelines.put('v2', { items: [] }, {
        parents: [{ store_id: 'timelines', version: 'v1', role: 'source' }],
      })
      
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.parents).toHaveLength(1)
      expect(result.value.parents[0].store_id).toBe('timelines')
      expect(result.value.parents[0].version).toBe('v1')
      expect(result.value.parents[0].role).toBe('source')
    })

    it('preserves parents on get', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      await corpus.stores.timelines.put('v2', { items: [] }, {
        parents: [{ store_id: 'timelines', version: 'v1' }],
      })
      
      const result = await corpus.stores.timelines.get('v2')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.meta.parents).toHaveLength(1)
      expect(result.value.meta.parents[0].version).toBe('v1')
    })

    it('get_children returns snapshots with matching parent', async () => {
      await corpus.stores.timelines.put('parent', { items: [] })
      await corpus.stores.timelines.put('child1', { items: [] }, {
        parents: [{ store_id: 'timelines', version: 'parent' }],
      })
      await corpus.stores.timelines.put('child2', { items: [] }, {
        parents: [{ store_id: 'timelines', version: 'parent' }],
      })
      await corpus.stores.timelines.put('unrelated', { items: [] })
      
      const children: string[] = []
      for await (const meta of corpus.metadata.get_children('timelines', 'parent')) {
        children.push(meta.version)
      }
      
      expect(children).toHaveLength(2)
      expect(children).toContain('child1')
      expect(children).toContain('child2')
      expect(children).not.toContain('unrelated')
    })

    it('supports multiple parents', async () => {
      await corpus.stores.timelines.put('source1', { items: [] })
      await corpus.stores.timelines.put('source2', { items: [] })
      
      const result = await corpus.stores.timelines.put('derived', { items: [] }, {
        parents: [
          { store_id: 'timelines', version: 'source1', role: 'primary' },
          { store_id: 'timelines', version: 'source2', role: 'secondary' },
        ],
      })
      
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.parents).toHaveLength(2)
    })
  })

  describe('tags and filtering', () => {
    it('stores tags on put', async () => {
      const result = await corpus.stores.timelines.put('v1', { items: [] }, {
        tags: ['important', 'daily'],
      })
      
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.tags).toEqual(['important', 'daily'])
    })

    it('filters list by tags', async () => {
      await corpus.stores.timelines.put('v1', { items: [] }, { tags: ['a'] })
      await corpus.stores.timelines.put('v2', { items: [] }, { tags: ['b'] })
      await corpus.stores.timelines.put('v3', { items: [] }, { tags: ['a', 'b'] })
      
      const tagged_a: string[] = []
      for await (const meta of corpus.stores.timelines.list({ tags: ['a'] })) {
        tagged_a.push(meta.version)
      }
      
      expect(tagged_a).toHaveLength(2)
      expect(tagged_a).toContain('v1')
      expect(tagged_a).toContain('v3')
    })

    it('filters list with limit', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      await corpus.stores.timelines.put('v2', { items: [] })
      await corpus.stores.timelines.put('v3', { items: [] })
      
      const limited: string[] = []
      for await (const meta of corpus.stores.timelines.list({ limit: 2 })) {
        limited.push(meta.version)
      }
      
      expect(limited).toHaveLength(2)
    })

    it('filters list by before date', async () => {
      const now = new Date()
      await corpus.stores.timelines.put('v1', { items: [] })
      
      const future = new Date(now.getTime() + 10000)
      
      const before_future: string[] = []
      for await (const meta of corpus.stores.timelines.list({ before: future })) {
        before_future.push(meta.version)
      }
      expect(before_future).toHaveLength(1)
      
      const past = new Date(now.getTime() - 10000)
      const before_past: string[] = []
      for await (const meta of corpus.stores.timelines.list({ before: past })) {
        before_past.push(meta.version)
      }
      expect(before_past).toHaveLength(0)
    })
  })

  describe('event observability', () => {
    it('fires events for put operation', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      
      const event_types = events.map(e => e.type)
      
      expect(event_types).toContain('data_put')
      expect(event_types).toContain('meta_put')
      expect(event_types).toContain('snapshot_put')
    })

    it('fires events for get operation', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      events.length = 0
      
      await corpus.stores.timelines.get('v1')
      
      const event_types = events.map(e => e.type)
      expect(event_types).toContain('meta_get')
      expect(event_types).toContain('data_get')
      expect(event_types).toContain('snapshot_get')
    })

    it('fires meta_get with found=false for missing', async () => {
      await corpus.stores.timelines.get('nonexistent')
      
      const meta_get = events.find(e => e.type === 'meta_get') as Extract<CorpusEvent, { type: 'meta_get' }>
      expect(meta_get).toBeDefined()
      expect(meta_get.found).toBe(false)
    })

    it('fires meta_list with count', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      await corpus.stores.timelines.put('v2', { items: [] })
      events.length = 0
      
      for await (const _ of corpus.stores.timelines.list()) {}
      
      const meta_list = events.find(e => e.type === 'meta_list') as Extract<CorpusEvent, { type: 'meta_list' }>
      expect(meta_list).toBeDefined()
      expect(meta_list.count).toBe(2)
    })

    it('records snapshot_put with content_hash', async () => {
      await corpus.stores.timelines.put('v1', { items: [] })
      
      const snapshot_put = events.find(e => e.type === 'snapshot_put') as Extract<CorpusEvent, { type: 'snapshot_put' }>
      expect(snapshot_put).toBeDefined()
      expect(snapshot_put.content_hash).toBeString()
      expect(snapshot_put.store_id).toBe('timelines')
      expect(snapshot_put.version).toBe('v1')
    })
  })

  describe('multiple stores', () => {
    const UserSchema = z.object({
      name: z.string(),
      email: z.string(),
    })
    type User = z.infer<typeof UserSchema>

    it('supports multiple independent stores', async () => {
      const multi_corpus = create_corpus()
        .with_backend(create_memory_backend())
        .with_store(define_store('timelines', json_codec(TimelineSchema)))
        .with_store(define_store('users', json_codec(UserSchema)))
        .build()

      await multi_corpus.stores.timelines.put('t1', { items: [] })
      await multi_corpus.stores.users.put('u1', { name: 'Alice', email: 'alice@test.com' })

      const timeline = await multi_corpus.stores.timelines.get('t1')
      const user = await multi_corpus.stores.users.get('u1')

      expect(timeline.ok).toBe(true)
      expect(user.ok).toBe(true)
      
      if (timeline.ok) {
        expect(timeline.value.data.items).toEqual([])
      }
      if (user.ok) {
        expect(user.value.data.name).toBe('Alice')
      }
    })

    it('stores are isolated from each other', async () => {
      const multi_corpus = create_corpus()
        .with_backend(create_memory_backend())
        .with_store(define_store('store_a', json_codec(ItemSchema)))
        .with_store(define_store('store_b', json_codec(ItemSchema)))
        .build()

      await multi_corpus.stores.store_a.put('v1', { id: '1', text: 'a' })
      await multi_corpus.stores.store_b.put('v1', { id: '1', text: 'b' })

      const a = await multi_corpus.stores.store_a.get('v1')
      const b = await multi_corpus.stores.store_b.get('v1')

      expect(a.ok && b.ok).toBe(true)
      if (a.ok && b.ok) {
        expect(a.value.data.text).toBe('a')
        expect(b.value.data.text).toBe('b')
      }
    })

    it('list only returns snapshots from own store', async () => {
      const multi_corpus = create_corpus()
        .with_backend(create_memory_backend())
        .with_store(define_store('store_a', json_codec(ItemSchema)))
        .with_store(define_store('store_b', json_codec(ItemSchema)))
        .build()

      await multi_corpus.stores.store_a.put('a1', { id: '1', text: 'a' })
      await multi_corpus.stores.store_a.put('a2', { id: '2', text: 'a' })
      await multi_corpus.stores.store_b.put('b1', { id: '1', text: 'b' })

      const a_versions: string[] = []
      for await (const meta of multi_corpus.stores.store_a.list()) {
        a_versions.push(meta.version)
      }

      expect(a_versions).toHaveLength(2)
      expect(a_versions).toContain('a1')
      expect(a_versions).toContain('a2')
      expect(a_versions).not.toContain('b1')
    })
  })

  describe('invoked_at metadata', () => {
    it('stores invoked_at timestamp', async () => {
      const invoked = new Date('2024-01-15T10:00:00Z')
      
      const result = await corpus.stores.timelines.put('v1', { items: [] }, {
        invoked_at: invoked,
      })
      
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.invoked_at).toEqual(invoked)
    })

    it('preserves invoked_at on get', async () => {
      const invoked = new Date('2024-01-15T10:00:00Z')
      await corpus.stores.timelines.put('v1', { items: [] }, { invoked_at: invoked })
      
      const result = await corpus.stores.timelines.get('v1')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      
      expect(result.value.meta.invoked_at).toEqual(invoked)
    })
  })
})
