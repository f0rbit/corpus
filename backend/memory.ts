import type { Backend, MetadataClient, DataClient, SnapshotMeta, DataHandle, ListOpts } from '../types'

export function create_memory_backend(): Backend {
  const meta_store = new Map<string, SnapshotMeta>()
  const data_store = new Map<string, Uint8Array>()
  
  function make_key(store_id: string, version: string): string {
    return `${store_id}:${version}`
  }

  const metadata: MetadataClient = {
    async get(store_id, version) {
      return meta_store.get(make_key(store_id, version)) ?? null
    },

    async put(meta) {
      meta_store.set(make_key(meta.store_id, meta.version), meta)
    },

    async delete(store_id, version) {
      meta_store.delete(make_key(store_id, version))
    },

    async *list(store_id, opts): AsyncIterable<SnapshotMeta> {
      const prefix = `${store_id}:`
      const matches: SnapshotMeta[] = []
      
      for (const [key, meta] of meta_store) {
        if (!key.startsWith(prefix)) continue
        if (opts?.before && meta.created_at >= opts.before) continue
        if (opts?.after && meta.created_at <= opts.after) continue
        if (opts?.tags?.length && !opts.tags.some(t => meta.tags?.includes(t))) continue
        matches.push(meta)
      }
      
      matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      
      const limit = opts?.limit ?? Infinity
      for (const match of matches.slice(0, limit)) {
        yield match
      }
    },

    async get_latest(store_id) {
      for await (const meta of this.list(store_id, { limit: 1 })) {
        return meta
      }
      return null
    },

    async *get_children(parent_store_id, parent_version) {
      for (const meta of meta_store.values()) {
        const is_child = meta.parents.some(
          p => p.store_id === parent_store_id && p.version === parent_version
        )
        if (is_child) yield meta
      }
    },
  }

  const data: DataClient = {
    async get(store_id, version) {
      const bytes = data_store.get(make_key(store_id, version))
      if (!bytes) return null
      
      return {
        stream: () => new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          }
        }),
        bytes: async () => bytes,
      }
    },

    async put(store_id, version, input) {
      let bytes: Uint8Array
      
      if (input instanceof Uint8Array) {
        bytes = input
      } else {
        const chunks: Uint8Array[] = []
        const reader = input.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        bytes = concat_bytes(chunks)
      }
      
      data_store.set(make_key(store_id, version), bytes)
    },

    async delete(store_id, version) {
      data_store.delete(make_key(store_id, version))
    },
  }

  return { metadata, data }
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
