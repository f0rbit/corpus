import type { Backend, MetadataClient, DataClient, SnapshotMeta, ListOpts, Result, CorpusError, CorpusEvent, EventHandler } from '../types'
import { ok, err } from '../types'
import { mkdir, unlink, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export type FileBackendConfig = {
  base_path: string
  on_event?: EventHandler
}

export function create_file_backend(config: FileBackendConfig): Backend {
  const { base_path, on_event } = config

  function emit(event: CorpusEvent) {
    on_event?.(event)
  }

  function meta_path(store_id: string): string {
    return join(base_path, store_id, '_meta.json')
  }

  function data_path(data_key: string): string {
    return join(base_path, '_data', `${data_key.replace(/\//g, '_')}.bin`)
  }

  async function read_store_meta(store_id: string): Promise<Map<string, SnapshotMeta>> {
    const path = meta_path(store_id)
    const file = Bun.file(path)
    if (!await file.exists()) return new Map()
    
    try {
      const content = await file.text()
      const entries = JSON.parse(content, (key, value) => {
        if (key === 'created_at' || key === 'invoked_at') {
          return value ? new Date(value) : value
        }
        return value
      }) as [string, SnapshotMeta][]
      return new Map(entries)
    } catch {
      return new Map()
    }
  }

  async function write_store_meta(store_id: string, meta_map: Map<string, SnapshotMeta>): Promise<void> {
    const path = meta_path(store_id)
    await mkdir(dirname(path), { recursive: true })
    const entries = Array.from(meta_map.entries())
    await Bun.write(path, JSON.stringify(entries))
  }

  const metadata: MetadataClient = {
    async get(store_id, version): Promise<Result<SnapshotMeta, CorpusError>> {
      const store_meta = await read_store_meta(store_id)
      const meta = store_meta.get(version)
      emit({ type: 'meta_get', store_id, version, found: !!meta })
      if (!meta) {
        return err({ kind: 'not_found', store_id, version })
      }
      return ok(meta)
    },

    async put(meta): Promise<Result<void, CorpusError>> {
      const store_meta = await read_store_meta(meta.store_id)
      store_meta.set(meta.version, meta)
      await write_store_meta(meta.store_id, store_meta)
      emit({ type: 'meta_put', store_id: meta.store_id, version: meta.version })
      return ok(undefined)
    },

    async delete(store_id, version): Promise<Result<void, CorpusError>> {
      const store_meta = await read_store_meta(store_id)
      store_meta.delete(version)
      await write_store_meta(store_id, store_meta)
      emit({ type: 'meta_delete', store_id, version })
      return ok(undefined)
    },

    async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
      const store_meta = await read_store_meta(store_id)
      
      const matches = Array.from(store_meta.values())
        .filter(meta => {
          if (opts?.before && meta.created_at >= opts.before) return false
          if (opts?.after && meta.created_at <= opts.after) return false
          if (opts?.tags?.length && !opts.tags.some(t => meta.tags?.includes(t))) return false
          return true
        })
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      
      const limit = opts?.limit ?? Infinity
      let count = 0
      for (const meta of matches.slice(0, limit)) {
        yield meta
        count++
      }
      emit({ type: 'meta_list', store_id, count })
    },

    async get_latest(store_id): Promise<Result<SnapshotMeta, CorpusError>> {
      const store_meta = await read_store_meta(store_id)
      
      let latest: SnapshotMeta | null = null
      for (const meta of store_meta.values()) {
        if (!latest || meta.created_at > latest.created_at) {
          latest = meta
        }
      }
      
      if (!latest) {
        return err({ kind: 'not_found', store_id, version: 'latest' })
      }
      return ok(latest)
    },

    async *get_children(parent_store_id, parent_version): AsyncIterable<SnapshotMeta> {
      try {
        const entries = await readdir(base_path, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('_')) continue
          
          const store_meta = await read_store_meta(entry.name)
          for (const meta of store_meta.values()) {
            const is_child = meta.parents.some(
              p => p.store_id === parent_store_id && p.version === parent_version
            )
            if (is_child) yield meta
          }
        }
      } catch {
      }
    },

    async find_by_hash(store_id, content_hash): Promise<SnapshotMeta | null> {
      const store_meta = await read_store_meta(store_id)
      for (const meta of store_meta.values()) {
        if (meta.content_hash === content_hash) {
          return meta
        }
      }
      return null
    },
  }

  const data: DataClient = {
    async get(data_key): Promise<Result<{ stream: () => ReadableStream<Uint8Array>; bytes: () => Promise<Uint8Array> }, CorpusError>> {
      const path = data_path(data_key)
      const file = Bun.file(path)
      
      const found = await file.exists()
      emit({ type: 'data_get', store_id: data_key.split('/')[0] ?? data_key, version: data_key, found })
      
      if (!found) {
        return err({ kind: 'not_found', store_id: data_key, version: '' })
      }

      return ok({
        stream: () => file.stream(),
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
      })
    },

    async put(data_key, input): Promise<Result<void, CorpusError>> {
      const path = data_path(data_key)
      await mkdir(dirname(path), { recursive: true })
      
      try {
        if (input instanceof Uint8Array) {
          await Bun.write(path, input)
        } else {
          const chunks: Uint8Array[] = []
          const reader = input.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
          }
          const bytes = concat_bytes(chunks)
          await Bun.write(path, bytes)
        }
        return ok(undefined)
      } catch (cause) {
        return err({ kind: 'storage_error', cause: cause as Error, operation: 'put' })
      }
    },

    async delete(data_key): Promise<Result<void, CorpusError>> {
      const path = data_path(data_key)
      try {
        const file = Bun.file(path)
        if (await file.exists()) {
          await unlink(path)
        }
        return ok(undefined)
      } catch (cause) {
        return err({ kind: 'storage_error', cause: cause as Error, operation: 'delete' })
      }
    },

    async exists(data_key): Promise<boolean> {
      const path = data_path(data_key)
      const file = Bun.file(path)
      return file.exists()
    },
  }

  return { metadata, data, on_event }
}

function concat_bytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
