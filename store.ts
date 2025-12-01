import type { Backend, Store, StoreConfig, SnapshotMeta } from './types'
import { compute_hash } from './hash'

export function create_store<T>(backend: Backend, config: StoreConfig<T>): Store<T> {
  const { id, codec } = config

  return {
    id,
    codec,

    async put(version, data, opts) {
      const bytes = codec.encode(data)
      const content_hash = await compute_hash(bytes)

      const meta: SnapshotMeta = {
        store_id: id,
        version,
        parents: opts?.parents ?? [],
        created_at: new Date(),
        invoked_at: opts?.invoked_at,
        content_hash,
        content_type: codec.content_type,
        size_bytes: bytes.length,
        tags: opts?.tags,
      }

      await backend.data.put(id, version, bytes)
      await backend.metadata.put(meta)

      return meta
    },

    async get(version) {
      const meta = await backend.metadata.get(id, version)
      if (!meta) return null

      const handle = await backend.data.get(id, version)
      if (!handle) return null

      const bytes = await handle.bytes()
      const data = codec.decode(bytes)

      return { meta, data }
    },

    async get_latest() {
      const meta = await backend.metadata.get_latest(id)
      if (!meta) return null

      const handle = await backend.data.get(id, meta.version)
      if (!handle) return null

      const bytes = await handle.bytes()
      const data = codec.decode(bytes)

      return { meta, data }
    },

    async get_meta(version) {
      return backend.metadata.get(id, version)
    },

    list(opts) {
      return backend.metadata.list(id, opts)
    },

    async delete(version) {
      await backend.data.delete(id, version)
      await backend.metadata.delete(id, version)
    },
  }
}
