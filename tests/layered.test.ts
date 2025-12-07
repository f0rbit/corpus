import { describe, it, expect, beforeEach } from 'bun:test'
import { z } from 'zod'
import {
  create_corpus,
  create_memory_backend,
  create_layered_backend,
  define_store,
  json_codec,
  type Corpus,
  type Store,
  type Backend,
  type SnapshotMeta,
} from '../index'

const ItemSchema = z.object({
  id: z.string(),
  text: z.string(),
})

type Item = z.infer<typeof ItemSchema>

describe('layered backend', () => {
  let memory1: Backend
  let memory2: Backend
  let write_only: Backend
  let corpus: Corpus<{ items: Store<Item> }>

  beforeEach(() => {
    memory1 = create_memory_backend()
    memory2 = create_memory_backend()
    write_only = create_memory_backend()
  })

  describe('read fallback', () => {
    it('returns from first backend when present', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory1.data.put('items/v1', new TextEncoder().encode('first'))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const meta_result = await layered.metadata.get('items', 'v1')
      expect(meta_result.ok).toBe(true)
      if (!meta_result.ok) return
      expect(meta_result.value.version).toBe('v1')

      const data_result = await layered.data.get('items/v1')
      expect(data_result.ok).toBe(true)
      if (!data_result.ok) return
      expect(await data_result.value.bytes()).toEqual(new TextEncoder().encode('first'))
    })

    it('falls back to second backend when first returns not_found', async () => {
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-02')))
      await memory2.data.put('items/v2', new TextEncoder().encode('second'))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const meta_result = await layered.metadata.get('items', 'v2')
      expect(meta_result.ok).toBe(true)
      if (!meta_result.ok) return
      expect(meta_result.value.version).toBe('v2')

      const data_result = await layered.data.get('items/v2')
      expect(data_result.ok).toBe(true)
    })

    it('returns not_found when no backend has the item', async () => {
      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.get('items', 'missing')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_found')
    })

    it('returns not_found when read array is empty', async () => {
      const layered = create_layered_backend({
        read: [],
        write: [],
      })

      const result = await layered.metadata.get('items', 'any')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_found')
    })
  })

  describe('write behavior', () => {
    it('writes only to write backends', async () => {
      const layered = create_layered_backend({
        read: [memory1],
        write: [write_only],
      })

      const meta = make_meta('items', 'v1', new Date())
      await layered.metadata.put(meta)
      await layered.data.put('items/v1', new TextEncoder().encode('data'))

      const in_read = await memory1.metadata.get('items', 'v1')
      expect(in_read.ok).toBe(false)

      const in_write = await write_only.metadata.get('items', 'v1')
      expect(in_write.ok).toBe(true)
    })

    it('writes to all write backends', async () => {
      const layered = create_layered_backend({
        read: [],
        write: [memory1, memory2],
      })

      const meta = make_meta('items', 'v1', new Date())
      await layered.metadata.put(meta)
      await layered.data.put('items/v1', new TextEncoder().encode('data'))

      const in_first = await memory1.metadata.get('items', 'v1')
      const in_second = await memory2.metadata.get('items', 'v1')
      expect(in_first.ok).toBe(true)
      expect(in_second.ok).toBe(true)
    })

    it('no-ops when write array is empty', async () => {
      const layered = create_layered_backend({
        read: [memory1],
        write: [],
      })

      const meta = make_meta('items', 'v1', new Date())
      const result = await layered.metadata.put(meta)
      expect(result.ok).toBe(true)

      const data_result = await layered.data.put('items/v1', new TextEncoder().encode('data'))
      expect(data_result.ok).toBe(true)
    })

    it('buffers stream data when writing to multiple backends', async () => {
      const layered = create_layered_backend({
        read: [],
        write: [memory1, memory2],
      })

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'))
          controller.enqueue(new TextEncoder().encode('chunk2'))
          controller.close()
        },
      })

      await layered.data.put('items/streamed', stream)

      const result1 = await memory1.data.get('items/streamed')
      const result2 = await memory2.data.get('items/streamed')

      expect(result1.ok).toBe(true)
      expect(result2.ok).toBe(true)
      if (!result1.ok || !result2.ok) return

      const bytes1 = await result1.value.bytes()
      const bytes2 = await result2.value.bytes()
      expect(bytes1).toEqual(new TextEncoder().encode('chunk1chunk2'))
      expect(bytes2).toEqual(new TextEncoder().encode('chunk1chunk2'))
    })
  })

  describe('list merging', () => {
    it('merges results from multiple read backends', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-02')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
        list_strategy: 'merge',
      })

      const versions: string[] = []
      for await (const meta of layered.metadata.list('items')) {
        versions.push(meta.version)
      }

      expect(versions).toHaveLength(2)
      expect(versions).toContain('v1')
      expect(versions).toContain('v2')
    })

    it('deduplicates by version', async () => {
      const same_meta = make_meta('items', 'v1', new Date('2024-01-01'))
      await memory1.metadata.put(same_meta)
      await memory2.metadata.put(same_meta)

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const versions: string[] = []
      for await (const meta of layered.metadata.list('items')) {
        versions.push(meta.version)
      }

      expect(versions).toHaveLength(1)
      expect(versions[0]).toBe('v1')
    })

    it('sorts by created_at descending', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-03')))
      await memory1.metadata.put(make_meta('items', 'v3', new Date('2024-01-02')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const versions: string[] = []
      for await (const meta of layered.metadata.list('items')) {
        versions.push(meta.version)
      }

      expect(versions).toEqual(['v2', 'v3', 'v1'])
    })

    it('applies limit after merging', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-02')))
      await memory1.metadata.put(make_meta('items', 'v3', new Date('2024-01-03')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const versions: string[] = []
      for await (const meta of layered.metadata.list('items', { limit: 2 })) {
        versions.push(meta.version)
      }

      expect(versions).toHaveLength(2)
      expect(versions).toEqual(['v3', 'v2'])
    })

    it('uses first strategy when configured', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-02')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
        list_strategy: 'first',
      })

      const versions: string[] = []
      for await (const meta of layered.metadata.list('items')) {
        versions.push(meta.version)
      }

      expect(versions).toHaveLength(1)
      expect(versions[0]).toBe('v1')
    })
  })

  describe('get_latest', () => {
    it('returns newest across all read backends', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))
      await memory2.metadata.put(make_meta('items', 'v2', new Date('2024-01-03')))
      await memory1.metadata.put(make_meta('items', 'v3', new Date('2024-01-02')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.get_latest('items')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.version).toBe('v2')
    })

    it('returns not_found when no backends have data', async () => {
      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.get_latest('items')
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.kind).toBe('not_found')
    })

    it('handles one backend with data and one without', async () => {
      await memory2.metadata.put(make_meta('items', 'v1', new Date('2024-01-01')))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.get_latest('items')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.version).toBe('v1')
    })
  })

  describe('exists', () => {
    it('returns true if any read backend has the item', async () => {
      await memory2.data.put('items/v1', new TextEncoder().encode('data'))

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const exists = await layered.data.exists('items/v1')
      expect(exists).toBe(true)
    })

    it('returns false if no read backend has the item', async () => {
      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const exists = await layered.data.exists('items/missing')
      expect(exists).toBe(false)
    })
  })

  describe('delete behavior', () => {
    it('deletes from all write backends', async () => {
      await memory1.metadata.put(make_meta('items', 'v1', new Date()))
      await memory2.metadata.put(make_meta('items', 'v1', new Date()))

      const layered = create_layered_backend({
        read: [],
        write: [memory1, memory2],
      })

      const result = await layered.metadata.delete('items', 'v1')
      expect(result.ok).toBe(true)

      const in_first = await memory1.metadata.get('items', 'v1')
      const in_second = await memory2.metadata.get('items', 'v1')
      expect(in_first.ok).toBe(false)
      expect(in_second.ok).toBe(false)
    })

    it('ignores not_found errors on delete', async () => {
      const layered = create_layered_backend({
        read: [],
        write: [memory1, memory2],
      })

      const result = await layered.metadata.delete('items', 'nonexistent')
      expect(result.ok).toBe(true)
    })
  })

  describe('get_children', () => {
    it('merges children from all read backends', async () => {
      const parent = make_meta('items', 'parent', new Date('2024-01-01'))
      await memory1.metadata.put(parent)

      const child1 = make_meta('items', 'child1', new Date('2024-01-02'))
      child1.parents = [{ store_id: 'items', version: 'parent' }]
      await memory1.metadata.put(child1)

      const child2 = make_meta('items', 'child2', new Date('2024-01-03'))
      child2.parents = [{ store_id: 'items', version: 'parent' }]
      await memory2.metadata.put(child2)

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const children: string[] = []
      for await (const meta of layered.metadata.get_children('items', 'parent')) {
        children.push(meta.version)
      }

      expect(children).toHaveLength(2)
      expect(children).toContain('child1')
      expect(children).toContain('child2')
    })

    it('deduplicates children by store_id:version', async () => {
      const child = make_meta('items', 'child1', new Date('2024-01-02'))
      child.parents = [{ store_id: 'items', version: 'parent' }]
      await memory1.metadata.put(child)
      await memory2.metadata.put(child)

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const children: string[] = []
      for await (const meta of layered.metadata.get_children('items', 'parent')) {
        children.push(meta.version)
      }

      expect(children).toHaveLength(1)
    })
  })

  describe('find_by_hash', () => {
    it('finds in first backend with match', async () => {
      const meta = make_meta('items', 'v1', new Date())
      meta.content_hash = 'abc123'
      await memory1.metadata.put(meta)

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.find_by_hash('items', 'abc123')
      expect(result).not.toBeNull()
      expect(result?.version).toBe('v1')
    })

    it('falls back to second backend', async () => {
      const meta = make_meta('items', 'v1', new Date())
      meta.content_hash = 'abc123'
      await memory2.metadata.put(meta)

      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.find_by_hash('items', 'abc123')
      expect(result).not.toBeNull()
      expect(result?.version).toBe('v1')
    })

    it('returns null when no backend has match', async () => {
      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [],
      })

      const result = await layered.metadata.find_by_hash('items', 'nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('integration with corpus', () => {
    it('works with corpus builder', async () => {
      const layered = create_layered_backend({
        read: [memory1, memory2],
        write: [memory1],
      })

      corpus = create_corpus()
        .with_backend(layered)
        .with_store(define_store('items', json_codec(ItemSchema)))
        .build()

      const put_result = await corpus.stores.items.put({ id: '1', text: 'hello' })
      expect(put_result.ok).toBe(true)
      if (!put_result.ok) return

      const get_result = await corpus.stores.items.get(put_result.value.version)
      expect(get_result.ok).toBe(true)
      if (!get_result.ok) return
      expect(get_result.value.data).toEqual({ id: '1', text: 'hello' })
    })
  })
})

function make_meta(store_id: string, version: string, created_at: Date): SnapshotMeta {
  return {
    store_id,
    version,
    parents: [],
    created_at,
    content_hash: `hash_${version}`,
    content_type: 'application/json',
    size_bytes: 0,
    data_key: `${store_id}/${version}`,
  }
}
