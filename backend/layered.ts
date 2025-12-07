import type { Backend, MetadataClient, DataClient, SnapshotMeta, Result, CorpusError, DataHandle } from '../types'
import { ok, err } from '../types'

export type LayeredBackendOptions = {
  read: Backend[]
  write: Backend[]
  list_strategy?: 'merge' | 'first'
}

export function create_layered_backend(options: LayeredBackendOptions): Backend {
  const { read, write, list_strategy = 'merge' } = options

  const metadata: MetadataClient = {
    async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
      for (const backend of read) {
        const result = await backend.metadata.get(store_id, version)
        if (result.ok) return result
        if (result.error.kind !== 'not_found') return result
      }
      return err({ kind: 'not_found', store_id, version })
    },

    async put(meta): Promise<Result<void, CorpusError>> {
      for (const backend of write) {
        const result = await backend.metadata.put(meta)
        if (!result.ok) return result
      }
      return ok(undefined)
    },

    async delete(store_id, version): Promise<Result<void, CorpusError>> {
      for (const backend of write) {
        const result = await backend.metadata.delete(store_id, version)
        if (!result.ok && result.error.kind !== 'not_found') return result
      }
      return ok(undefined)
    },

    async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
      if (read.length === 0) return

      if (list_strategy === 'first') {
        yield* read[0]!.metadata.list(store_id, opts)
        return
      }

      const seen = new Set<string>()
      const all: SnapshotMeta[] = []

      for (const backend of read) {
        for await (const meta of backend.metadata.list(store_id, opts)) {
          if (seen.has(meta.version)) continue
          seen.add(meta.version)
          all.push(meta)
        }
      }

      all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())

      const limit = opts?.limit ?? Infinity
      for (const meta of all.slice(0, limit)) {
        yield meta
      }
    },

    async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
      let latest: SnapshotMeta | null = null

      for (const backend of read) {
        const result = await backend.metadata.get_latest(store_id)
        if (!result.ok) {
          if (result.error.kind !== 'not_found') return result
          continue
        }
        if (!latest || result.value.created_at > latest.created_at) {
          latest = result.value
        }
      }

      if (!latest) {
        return err({ kind: 'not_found', store_id, version: 'latest' })
      }
      return ok(latest)
    },

    async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
      const seen = new Set<string>()

      for (const backend of read) {
        for await (const meta of backend.metadata.get_children(parent_store_id, parent_version)) {
          const key = `${meta.store_id}:${meta.version}`
          if (seen.has(key)) continue
          seen.add(key)
          yield meta
        }
      }
    },

    async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
      for (const backend of read) {
        const result = await backend.metadata.find_by_hash(store_id, content_hash)
        if (result) return result
      }
      return null
    },
  }

  const data: DataClient = {
    async get(data_key): Promise<Result<DataHandle, CorpusError>> {
      for (const backend of read) {
        const result = await backend.data.get(data_key)
        if (result.ok) return result
        if (result.error.kind !== 'not_found') return result
      }
      return err({ kind: 'not_found', store_id: data_key, version: '' })
    },

    async put(data_key, data): Promise<Result<void, CorpusError>> {
      if (write.length === 0) return ok(undefined)

      if (write.length === 1) {
        return write[0]!.data.put(data_key, data)
      }

      const bytes = await to_bytes(data)
      for (const backend of write) {
        const result = await backend.data.put(data_key, bytes)
        if (!result.ok) return result
      }
      return ok(undefined)
    },

    async delete(data_key): Promise<Result<void, CorpusError>> {
      for (const backend of write) {
        const result = await backend.data.delete(data_key)
        if (!result.ok && result.error.kind !== 'not_found') return result
      }
      return ok(undefined)
    },

    async exists(data_key): Promise<boolean> {
      for (const backend of read) {
        if (await backend.data.exists(data_key)) return true
      }
      return false
    },
  }

  return { metadata, data }
}

async function to_bytes(data: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data

  const chunks: Uint8Array[] = []
  const reader = data.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
