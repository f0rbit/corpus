import { describe, it, expect, beforeEach } from 'bun:test'
import type { Backend, SnapshotMeta } from '../../types'

export type BackendFactory = () => Backend | Promise<Backend>
export type CleanupFn = () => void | Promise<void>

const makeMeta = (
  store_id: string,
  version: string,
  opts?: Partial<SnapshotMeta>
): SnapshotMeta => ({
  store_id,
  version,
  parents: [],
  created_at: new Date(),
  content_hash: `hash_${version}`,
  content_type: 'application/json',
  size_bytes: 0,
  data_key: `${store_id}/${opts?.content_hash ?? `hash_${version}`}`,
  ...opts,
})

export function runBackendContractTests(
  name: string,
  createBackend: BackendFactory,
  cleanup?: CleanupFn
) {
  describe(`${name} - Backend Contract`, () => {
    let backend: Backend

    beforeEach(async () => {
      backend = await createBackend()
      if (cleanup) await cleanup()
    })

    describe('metadata client', () => {
      describe('get', () => {
        it('returns not_found for missing version', async () => {
          const result = await backend.metadata.get('test-store', 'nonexistent')

          expect(result.ok).toBe(false)
          if (result.ok) return
          expect(result.error.kind).toBe('not_found')
          if (result.error.kind !== 'not_found') return
          expect(result.error.store_id).toBe('test-store')
          expect(result.error.version).toBe('nonexistent')
        })

        it('retrieves stored metadata', async () => {
          const meta = makeMeta('test-store', 'v1', { content_hash: 'abc123' })
          await backend.metadata.put(meta)

          const result = await backend.metadata.get('test-store', 'v1')

          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value.version).toBe('v1')
          expect(result.value.store_id).toBe('test-store')
          expect(result.value.content_hash).toBe('abc123')
        })
      })

      describe('put', () => {
        it('stores metadata successfully', async () => {
          const meta = makeMeta('test-store', 'v1')

          const result = await backend.metadata.put(meta)

          expect(result.ok).toBe(true)
        })

        it('allows storing multiple versions', async () => {
          const meta1 = makeMeta('test-store', 'v1')
          const meta2 = makeMeta('test-store', 'v2')

          await backend.metadata.put(meta1)
          await backend.metadata.put(meta2)

          const result1 = await backend.metadata.get('test-store', 'v1')
          const result2 = await backend.metadata.get('test-store', 'v2')

          expect(result1.ok).toBe(true)
          expect(result2.ok).toBe(true)
        })

        it('preserves all metadata fields on roundtrip', async () => {
          const created = new Date('2024-01-15T10:00:00Z')
          const invoked = new Date('2024-01-15T09:00:00Z')
          const meta = makeMeta('test-store', 'v1', {
            parents: [{ store_id: 'parent-store', version: 'p1', role: 'source' }],
            created_at: created,
            invoked_at: invoked,
            content_hash: 'hash123',
            content_type: 'text/plain',
            size_bytes: 1024,
            tags: ['important', 'reviewed'],
          })

          await backend.metadata.put(meta)
          const result = await backend.metadata.get('test-store', 'v1')

          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value.parents).toHaveLength(1)
          expect(result.value.parents[0]?.role).toBe('source')
          expect(result.value.content_type).toBe('text/plain')
          expect(result.value.size_bytes).toBe(1024)
          expect(result.value.tags).toEqual(['important', 'reviewed'])
        })
      })

      describe('delete', () => {
        it('removes stored metadata', async () => {
          const meta = makeMeta('test-store', 'v1')
          await backend.metadata.put(meta)

          const deleteResult = await backend.metadata.delete('test-store', 'v1')
          expect(deleteResult.ok).toBe(true)

          const getResult = await backend.metadata.get('test-store', 'v1')
          expect(getResult.ok).toBe(false)
        })

        it('succeeds when deleting non-existent metadata', async () => {
          const result = await backend.metadata.delete('test-store', 'nonexistent')

          expect(result.ok).toBe(true)
        })
      })

      describe('list', () => {
        it('returns empty for store with no versions', async () => {
          const versions: string[] = []
          for await (const meta of backend.metadata.list('empty-store')) {
            versions.push(meta.version)
          }

          expect(versions).toHaveLength(0)
        })

        it('returns all versions for a store', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1'))
          await backend.metadata.put(makeMeta('test-store', 'v2'))
          await backend.metadata.put(makeMeta('test-store', 'v3'))

          const versions: string[] = []
          for await (const meta of backend.metadata.list('test-store')) {
            versions.push(meta.version)
          }

          expect(versions).toHaveLength(3)
          expect(versions).toContain('v1')
          expect(versions).toContain('v2')
          expect(versions).toContain('v3')
        })

        it('only returns versions from requested store', async () => {
          await backend.metadata.put(makeMeta('store-a', 'v1'))
          await backend.metadata.put(makeMeta('store-b', 'v2'))

          const versions: string[] = []
          for await (const meta of backend.metadata.list('store-a')) {
            versions.push(meta.version)
          }

          expect(versions).toHaveLength(1)
          expect(versions).toContain('v1')
        })

        it('respects limit option', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1', { created_at: new Date('2024-01-01') }))
          await backend.metadata.put(makeMeta('test-store', 'v2', { created_at: new Date('2024-01-02') }))
          await backend.metadata.put(makeMeta('test-store', 'v3', { created_at: new Date('2024-01-03') }))

          const versions: string[] = []
          for await (const meta of backend.metadata.list('test-store', { limit: 2 })) {
            versions.push(meta.version)
          }

          expect(versions).toHaveLength(2)
        })

        it('filters by tags when provided', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1', { tags: ['alpha'] }))
          await backend.metadata.put(makeMeta('test-store', 'v2', { tags: ['beta'] }))
          await backend.metadata.put(makeMeta('test-store', 'v3', { tags: ['alpha', 'beta'] }))

          const versions: string[] = []
          for await (const meta of backend.metadata.list('test-store', { tags: ['alpha'] })) {
            versions.push(meta.version)
          }

          expect(versions).toHaveLength(2)
          expect(versions).toContain('v1')
          expect(versions).toContain('v3')
        })
      })

      describe('get_latest', () => {
        it('returns not_found for empty store', async () => {
          const result = await backend.metadata.get_latest('empty-store')

          expect(result.ok).toBe(false)
          if (result.ok) return
          expect(result.error.kind).toBe('not_found')
        })

        it('returns newest by created_at', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1', { created_at: new Date('2024-01-01') }))
          await backend.metadata.put(makeMeta('test-store', 'v2', { created_at: new Date('2024-01-03') }))
          await backend.metadata.put(makeMeta('test-store', 'v3', { created_at: new Date('2024-01-02') }))

          const result = await backend.metadata.get_latest('test-store')

          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value.version).toBe('v2')
        })
      })

      describe('get_children', () => {
        it('returns empty when no children exist', async () => {
          await backend.metadata.put(makeMeta('test-store', 'parent'))

          const children: string[] = []
          for await (const meta of backend.metadata.get_children('test-store', 'parent')) {
            children.push(meta.version)
          }

          expect(children).toHaveLength(0)
        })

        it('returns all snapshots with matching parent', async () => {
          await backend.metadata.put(makeMeta('test-store', 'parent'))
          await backend.metadata.put(makeMeta('test-store', 'child1', {
            parents: [{ store_id: 'test-store', version: 'parent' }],
          }))
          await backend.metadata.put(makeMeta('test-store', 'child2', {
            parents: [{ store_id: 'test-store', version: 'parent' }],
          }))
          await backend.metadata.put(makeMeta('test-store', 'unrelated'))

          const children: string[] = []
          for await (const meta of backend.metadata.get_children('test-store', 'parent')) {
            children.push(meta.version)
          }

          expect(children).toHaveLength(2)
          expect(children).toContain('child1')
          expect(children).toContain('child2')
          expect(children).not.toContain('unrelated')
        })
      })

      describe('find_by_hash', () => {
        it('returns null when hash not found', async () => {
          const result = await backend.metadata.find_by_hash('test-store', 'nonexistent-hash')

          expect(result).toBeNull()
        })

        it('finds metadata by content hash', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1', { content_hash: 'target-hash' }))
          await backend.metadata.put(makeMeta('test-store', 'v2', { content_hash: 'other-hash' }))

          const result = await backend.metadata.find_by_hash('test-store', 'target-hash')

          expect(result).not.toBeNull()
          expect(result?.version).toBe('v1')
        })

        it('only searches within specified store', async () => {
          await backend.metadata.put(makeMeta('store-a', 'v1', { content_hash: 'shared-hash' }))
          await backend.metadata.put(makeMeta('store-b', 'v2', { content_hash: 'shared-hash' }))

          const result = await backend.metadata.find_by_hash('store-a', 'shared-hash')

          expect(result).not.toBeNull()
          expect(result?.store_id).toBe('store-a')
        })
      })
    })

    describe('data client', () => {
      describe('get', () => {
        it('returns not_found for missing data', async () => {
          const result = await backend.data.get('nonexistent-key')

          expect(result.ok).toBe(false)
          if (result.ok) return
          expect(result.error.kind).toBe('not_found')
        })

        it('retrieves stored bytes', async () => {
          const data = new TextEncoder().encode('hello world')
          await backend.data.put('test-key', data)

          const result = await backend.data.get('test-key')

          expect(result.ok).toBe(true)
          if (!result.ok) return
          const bytes = await result.value.bytes()
          expect(bytes).toEqual(data)
        })
      })

      describe('put', () => {
        it('stores bytes successfully', async () => {
          const data = new TextEncoder().encode('test data')

          const result = await backend.data.put('test-key', data)

          expect(result.ok).toBe(true)
        })

        it('preserves binary data exactly', async () => {
          const data = new Uint8Array([0, 1, 255, 128, 64, 32])
          await backend.data.put('binary-key', data)

          const result = await backend.data.get('binary-key')
          expect(result.ok).toBe(true)
          if (!result.ok) return

          const retrieved = await result.value.bytes()
          expect(retrieved).toEqual(data)
        })

        it('accepts ReadableStream input', async () => {
          const chunks = [
            new TextEncoder().encode('chunk1'),
            new TextEncoder().encode('chunk2'),
          ]
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk)
              }
              controller.close()
            },
          })

          await backend.data.put('stream-key', stream)

          const result = await backend.data.get('stream-key')
          expect(result.ok).toBe(true)
          if (!result.ok) return

          const bytes = await result.value.bytes()
          expect(bytes).toEqual(new TextEncoder().encode('chunk1chunk2'))
        })
      })

      describe('delete', () => {
        it('removes stored data', async () => {
          await backend.data.put('test-key', new TextEncoder().encode('data'))

          const deleteResult = await backend.data.delete('test-key')
          expect(deleteResult.ok).toBe(true)

          const getResult = await backend.data.get('test-key')
          expect(getResult.ok).toBe(false)
        })

        it('succeeds when deleting non-existent data', async () => {
          const result = await backend.data.delete('nonexistent-key')

          expect(result.ok).toBe(true)
        })
      })

      describe('exists', () => {
        it('returns false for missing data', async () => {
          const result = await backend.data.exists('nonexistent-key')

          expect(result).toBe(false)
        })

        it('returns true for existing data', async () => {
          await backend.data.put('test-key', new TextEncoder().encode('data'))

          const result = await backend.data.exists('test-key')

          expect(result).toBe(true)
        })
      })

      describe('data handle', () => {
        it('provides stream access to data', async () => {
          const data = new TextEncoder().encode('streaming test')
          await backend.data.put('stream-test', data)

          const result = await backend.data.get('stream-test')
          expect(result.ok).toBe(true)
          if (!result.ok) return

          const stream = result.value.stream()
          const reader = stream.getReader()
          const chunks: Uint8Array[] = []

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
          }

          const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0))
          let offset = 0
          for (const chunk of chunks) {
            combined.set(chunk, offset)
            offset += chunk.length
          }

          expect(combined).toEqual(data)
        })
      })
    })

    describe('cross-client consistency', () => {
      it('data_key links metadata to data', async () => {
        const data = new TextEncoder().encode('linked content')
        const dataKey = 'test-store/content-hash'

        await backend.data.put(dataKey, data)
        await backend.metadata.put(makeMeta('test-store', 'v1', { data_key: dataKey }))

        const metaResult = await backend.metadata.get('test-store', 'v1')
        expect(metaResult.ok).toBe(true)
        if (!metaResult.ok) return

        const dataResult = await backend.data.get(metaResult.value.data_key)
        expect(dataResult.ok).toBe(true)
        if (!dataResult.ok) return

        const bytes = await dataResult.value.bytes()
        expect(bytes).toEqual(data)
      })
    })
  })
}

import { create_memory_backend } from '../../backend/memory'
import { create_file_backend } from '../../backend/file'
import { create_layered_backend } from '../../backend/layered'
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

runBackendContractTests('MemoryBackend', () => create_memory_backend())

const fileTestDir = join(tmpdir(), 'corpus-contract-test-file')
runBackendContractTests(
  'FileBackend',
  async () => {
    await rm(fileTestDir, { recursive: true, force: true })
    await mkdir(fileTestDir, { recursive: true })
    return create_file_backend({ base_path: fileTestDir })
  },
  async () => {
    await rm(fileTestDir, { recursive: true, force: true })
  }
)

const layeredTestDir = join(tmpdir(), 'corpus-contract-test-layered')
runBackendContractTests(
  'LayeredBackend (memory read/write)',
  () => {
    const memory = create_memory_backend()
    return create_layered_backend({
      read: [memory],
      write: [memory],
    })
  }
)

runBackendContractTests(
  'LayeredBackend (file read/write)',
  async () => {
    await rm(layeredTestDir, { recursive: true, force: true })
    await mkdir(layeredTestDir, { recursive: true })
    const file = create_file_backend({ base_path: layeredTestDir })
    return create_layered_backend({
      read: [file],
      write: [file],
    })
  },
  async () => {
    await rm(layeredTestDir, { recursive: true, force: true })
  }
)
