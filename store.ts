import type { Backend, Store, StoreDefinition, SnapshotMeta, Result, CorpusError, PutOpts } from './types'
import { ok, err } from './types'
import { compute_hash } from './hash'
import { generate_version } from './version'

export function create_store<T>(backend: Backend, definition: StoreDefinition<string, T>): Store<T> {
  const { id, codec } = definition
  
  function emit(event: Parameters<NonNullable<Backend['on_event']>>[0]) {
    backend.on_event?.(event)
  }

  function make_data_key(store_id: string, content_hash: string): string {
    return `${store_id}/${content_hash}`
  }

  return {
    id,
    codec,

    async put(data, opts): Promise<Result<SnapshotMeta, CorpusError>> {
      const version = generate_version()
      
      let bytes: Uint8Array
      try {
        bytes = codec.encode(data)
      } catch (cause) {
        const error: CorpusError = { kind: 'encode_error', cause: cause as Error }
        emit({ type: 'error', error })
        return err(error)
      }

      const content_hash = await compute_hash(bytes)
      
      // deduplication: reuse existing data_key if content already exists
      const existing = await backend.metadata.find_by_hash(id, content_hash)
      const deduplicated = existing !== null
      const data_key = deduplicated ? existing.data_key : make_data_key(id, content_hash)

      if (!deduplicated) {
        const data_result = await backend.data.put(data_key, bytes)
        if (!data_result.ok) {
          emit({ type: 'error', error: data_result.error })
          return data_result
        }
      }

      emit({ type: 'data_put', store_id: id, version, size_bytes: bytes.length, deduplicated })

      const meta: SnapshotMeta = {
        store_id: id,
        version,
        parents: opts?.parents ?? [],
        created_at: new Date(),
        invoked_at: opts?.invoked_at,
        content_hash,
        content_type: codec.content_type,
        size_bytes: bytes.length,
        data_key,
        tags: opts?.tags,
      }

      const meta_result = await backend.metadata.put(meta)
      if (!meta_result.ok) {
        emit({ type: 'error', error: meta_result.error })
        return meta_result
      }

      emit({ type: 'snapshot_put', store_id: id, version, content_hash, deduplicated })
      return ok(meta)
    },

    async get(version): Promise<Result<{ meta: SnapshotMeta; data: T }, CorpusError>> {
      const meta_result = await backend.metadata.get(id, version)
      if (!meta_result.ok) {
        emit({ type: 'snapshot_get', store_id: id, version, found: false })
        return meta_result
      }

      const meta = meta_result.value
      const data_result = await backend.data.get(meta.data_key)
      if (!data_result.ok) {
        emit({ type: 'error', error: data_result.error })
        return data_result
      }

      const bytes = await data_result.value.bytes()
      let data: T
      try {
        data = codec.decode(bytes)
      } catch (cause) {
        const error: CorpusError = { kind: 'decode_error', cause: cause as Error }
        emit({ type: 'error', error })
        return err(error)
      }

      emit({ type: 'snapshot_get', store_id: id, version, found: true })
      return ok({ meta, data })
    },

    async get_latest(): Promise<Result<{ meta: SnapshotMeta; data: T }, CorpusError>> {
      const meta_result = await backend.metadata.get_latest(id)
      if (!meta_result.ok) {
        return meta_result
      }

      const meta = meta_result.value
      const data_result = await backend.data.get(meta.data_key)
      if (!data_result.ok) {
        return data_result
      }

      const bytes = await data_result.value.bytes()
      let data: T
      try {
        data = codec.decode(bytes)
      } catch (cause) {
        const error: CorpusError = { kind: 'decode_error', cause: cause as Error }
        emit({ type: 'error', error })
        return err(error)
      }

      return ok({ meta, data })
    },

    async get_meta(version): Promise<Result<SnapshotMeta, CorpusError>> {
      return backend.metadata.get(id, version)
    },

    list(opts) {
      return backend.metadata.list(id, opts)
    },

    async delete(version): Promise<Result<void, CorpusError>> {
      const meta_result = await backend.metadata.get(id, version)
      if (!meta_result.ok) {
        return meta_result
      }

      const delete_meta_result = await backend.metadata.delete(id, version)
      if (!delete_meta_result.ok) {
        return delete_meta_result
      }

      emit({ type: 'meta_delete', store_id: id, version })
      return ok(undefined)
    },
  }
}
