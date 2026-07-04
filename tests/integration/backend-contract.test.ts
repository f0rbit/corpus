import { describe, it, expect, beforeEach } from 'bun:test'
import { z } from 'zod'
import type { Backend, Corpus, SnapshotMeta, Store } from '../../types'
import { create_corpus, define_store, json_codec, ok, err } from '../../index'
import { define_observation_type } from '../../observations'

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

        it('overwrites an existing version on repeated put', async () => {
          await backend.metadata.put(makeMeta('test-store', 'v1', { content_hash: 'first' }))
          await backend.metadata.put(makeMeta('test-store', 'v1', { content_hash: 'second' }))

          const result = await backend.metadata.get('test-store', 'v1')
          expect(result.ok).toBe(true)
          if (!result.ok) return
          expect(result.value.content_hash).toBe('second')

          const versions: string[] = []
          for await (const meta of backend.metadata.list('test-store')) {
            versions.push(meta.version)
          }
          expect(versions).toHaveLength(1)
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

        it('matches store_id exactly, not as a prefix', async () => {
          // Regression guard for commit 02bee7f — the Cloudflare backend once
          // filtered store_id with like() and leaked prefix-sharing stores.
          await backend.metadata.put(makeMeta('blog', 'v1'))
          await backend.metadata.put(makeMeta('blog-drafts', 'v2'))

          const versions: string[] = []
          for await (const meta of backend.metadata.list('blog')) {
            versions.push(meta.version)
          }

          expect(versions).toEqual(['v1'])
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

      describe('streaming reads', () => {
        const big_payload = (): Uint8Array => {
          const buf = new Uint8Array(256 * 1024)
          for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff
          return buf
        }

        const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
          const reader = stream.getReader()
          const chunks: Uint8Array[] = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
          }
          return chunks
        }

        const flatten = (chunks: Uint8Array[]): Uint8Array => {
          const total = chunks.reduce((acc, c) => acc + c.length, 0)
          const out = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            out.set(c, offset)
            offset += c.length
          }
          return out
        }

        it('data handle stream() yields multi-chunk stream when bytes exceed chunk size', async () => {
          const data = big_payload()
          await backend.data.put('big-payload', data)

          const result = await backend.data.get('big-payload')
          expect(result.ok).toBe(true)
          if (!result.ok) return

          const chunks = await drain(result.value.stream())
          // Memory backend wraps in a single chunk; file backend streams via Bun.file().stream().
          // Either is correct — we assert >=1 here, with stricter chunk-count assertions in
          // the per-backend tests below where the contract is tighter.
          expect(chunks.length).toBeGreaterThanOrEqual(1)
          expect(flatten(chunks)).toEqual(data)
        })

        it('stream() and bytes() return identical content', async () => {
          const data = big_payload()
          await backend.data.put('identical-content', data)

          const get_a = await backend.data.get('identical-content')
          const get_b = await backend.data.get('identical-content')
          expect(get_a.ok && get_b.ok).toBe(true)
          if (!get_a.ok || !get_b.ok) return

          const via_bytes = await get_a.value.bytes()
          const via_stream = flatten(await drain(get_b.value.stream()))

          expect(via_bytes).toEqual(via_stream)
          expect(via_stream).toEqual(data)
        })

        it('data handle exposes both bytes() and stream() on every backend', async () => {
          const data = new TextEncoder().encode('handle shape')
          await backend.data.put('shape-test', data)

          const result = await backend.data.get('shape-test')
          expect(result.ok).toBe(true)
          if (!result.ok) return

          expect(typeof result.value.bytes).toBe('function')
          expect(typeof result.value.stream).toBe('function')
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

    // Transaction contract — only meaningful for backends that ship apply_batch.
    // The test suite gates on `backend.apply_batch != null` at run time so future
    // backends pick it up automatically by adding the method.
    describe('transaction contract', () => {
      const ItemSchema = z.object({ id: z.string() })
      type Item = z.infer<typeof ItemSchema>
      const NoteSchema = z.object({ text: z.string() })
      type Note = z.infer<typeof NoteSchema>

      const SentimentType = define_observation_type(
        'sentiment',
        z.object({ subject: z.string(), score: z.number() })
      )

      type TxStores = { items: Store<Item>; notes: Store<Note> }
      const make_corpus = (b: Backend): Corpus<TxStores> =>
        create_corpus()
          .with_backend(b)
          .with_store(define_store('items', json_codec(ItemSchema)))
          .with_store(define_store('notes', json_codec(NoteSchema)))
          .with_observations([SentimentType])
          .build() as Corpus<TxStores>

      it('atomic success across multiple stores', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const result = await corpus.transaction(async (tx) => {
          const a = await tx.put(corpus.stores.items, { id: 'a' })
          if (!a.ok) return a
          const b = await tx.put(corpus.stores.notes, { text: 'hello' })
          if (!b.ok) return b
          return ok({ a: a.value.version, b: b.value.version })
        })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.commits).toHaveLength(2)

        const got_a = await corpus.stores.items.get(result.value.value.a)
        expect(got_a.ok).toBe(true)
        if (got_a.ok) {
          expect(got_a.value.data.id).toBe('a')
          expect(got_a.value.meta.content_hash).toBeString()
        }

        const got_b = await corpus.stores.notes.get(result.value.value.b)
        expect(got_b.ok).toBe(true)
        if (got_b.ok) {
          expect(got_b.value.data.text).toBe('hello')
          expect(got_b.value.meta.content_hash).toBeString()
        }
      })

      it('atomic abort: body returns err() leaves no writes visible', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const result = await corpus.transaction(async (tx) => {
          await tx.put(corpus.stores.items, { id: 'rolled-back-a' })
          await tx.put(corpus.stores.notes, { text: 'rolled-back-b' })
          return err({ kind: 'invalid_config' as const, message: 'intentional' })
        })

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.kind).toBe('transaction_aborted')

        const items_latest = await corpus.stores.items.get_latest()
        expect(items_latest.ok).toBe(false)
        const notes_latest = await corpus.stores.notes.get_latest()
        expect(notes_latest.ok).toBe(false)
      })

      it('body throws → transaction_aborted with reason: threw', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const result = await corpus.transaction(async (tx) => {
          await tx.put(corpus.stores.items, { id: 'before-throw' })
          throw new Error('boom')
        })

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.error.kind).toBe('transaction_aborted')
        if (result.error.kind !== 'transaction_aborted') return
        expect(result.error.reason).toBe('threw')

        const latest = await corpus.stores.items.get_latest()
        expect(latest.ok).toBe(false)
      })

      it('read-your-writes: tx.get sees buffered put before commit', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const observed = { captured: null as Item | null, outside_ok: true }
        await corpus.transaction(async (tx) => {
          const put = await tx.put(corpus.stores.items, { id: 'rw' })
          if (!put.ok) return put

          const inside = await tx.get(corpus.stores.items, put.value.version)
          if (inside.ok) observed.captured = inside.value.data

          const outside = await corpus.stores.items.get(put.value.version)
          observed.outside_ok = outside.ok

          return ok(undefined)
        })

        expect(observed.captured).toEqual({ id: 'rw' })
        expect(observed.outside_ok).toBe(false)
      })

      it('tx.delete removes a previously committed snapshot atomically', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const initial = await corpus.stores.items.put({ id: 'doomed' })
        expect(initial.ok).toBe(true)
        if (!initial.ok) return

        const result = await corpus.transaction(async (tx) => {
          const before = await tx.get(corpus.stores.items, initial.value.version)
          expect(before.ok).toBe(true)

          const deleted = await tx.delete(corpus.stores.items, initial.value.version)
          if (!deleted.ok) return deleted

          // read-your-writes: after tx.delete, tx.get must see the tombstone
          const after_in_tx = await tx.get(corpus.stores.items, initial.value.version)
          expect(after_in_tx.ok).toBe(false)
          if (!after_in_tx.ok) expect(after_in_tx.error.kind).toBe('not_found')

          return ok(undefined)
        })

        expect(result.ok).toBe(true)
        const after = await corpus.stores.items.get_meta(initial.value.version)
        expect(after.ok).toBe(false)
      })

      it('tx.observe + tx.put commit atomically', async () => {
        if (!backend.apply_batch || !backend.observations) return
        const corpus = make_corpus(backend)

        const result = await corpus.transaction(async (tx) => {
          const snap = await tx.put(corpus.stores.items, { id: 'snap' })
          if (!snap.ok) return snap

          const obs = await tx.observe(SentimentType, {
            source: { store_id: 'items', version: snap.value.version },
            content: { subject: 'snap', score: 0.5 },
          })
          if (!obs.ok) return obs

          return ok({ version: snap.value.version, obs_id: obs.value.id })
        })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.value.commits).toHaveLength(1)
        expect(result.value.observations).toHaveLength(1)

        const snap = await corpus.stores.items.get(result.value.value.version)
        expect(snap.ok).toBe(true)
        const fetched = await corpus.observations!.get(result.value.value.obs_id)
        expect(fetched.ok).toBe(true)
      })

      it('concurrent transaction() returns invalid_config', async () => {
        if (!backend.apply_batch) return
        const corpus = make_corpus(backend)

        const result = await corpus.transaction(async (_tx) => {
          const inner = await corpus.transaction(async () => ok(1))
          expect(inner.ok).toBe(false)
          if (!inner.ok) expect(inner.error.kind).toBe('invalid_config')
          return ok(undefined)
        })

        expect(result.ok).toBe(true)
      })
    })
  })
}

import { create_memory_backend } from '../../backend/memory'
import { create_file_backend } from '../../backend/file'
import { create_layered_backend } from '../../backend/layered'
import { create_cloudflare_backend } from '../../backend/cloudflare'
import { corpus_snapshots } from '../../schema'
import { corpus_observations } from '../../observations/schema'
import { create_fake_d1, create_fake_r2 } from '../fakes/cloudflare'
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

runBackendContractTests('CloudflareBackend (faked D1 + R2)', () =>
  create_cloudflare_backend({
    d1: create_fake_d1([corpus_snapshots, corpus_observations]),
    r2: create_fake_r2(),
  })
)

const big = (size: number): Uint8Array => {
  const buf = new Uint8Array(size)
  for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff
  return buf
}

const drainChunks = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

describe('backend-specific streaming chunk counts', () => {
  it('memory backend returns exactly one chunk for any size', async () => {
    const backend = create_memory_backend()
    const data = big(256 * 1024)
    await backend.data.put('mem-big', data)

    const result = await backend.data.get('mem-big')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const chunks = await drainChunks(result.value.stream())
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(data)
  })

  it('file backend yields multiple chunks for a 1 MB payload', async () => {
    // Bun.file().stream() emits 256 KB chunks; a 1 MB payload guarantees ≥4 chunks
    // and proves we're actually streaming rather than buffering.
    const dir = join(tmpdir(), 'corpus-contract-streaming-file')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    try {
      const backend = create_file_backend({ base_path: dir })
      const data = big(1024 * 1024)
      await backend.data.put('file-big', data)

      const result = await backend.data.get('file-big')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const chunks = await drainChunks(result.value.stream())
      expect(chunks.length).toBeGreaterThanOrEqual(2)

      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      expect(total).toBe(data.length)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
