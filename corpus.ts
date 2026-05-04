/**
 * @module Core
 * @description Core corpus and store creation functions.
 */

import type { Backend, Corpus, CorpusBuilder, StoreDefinition, Store, SnapshotMeta, SnapshotHandle, Result, CorpusError, DataKeyContext, DataHandle, ObservationsClient } from './types.js';
import type { ObservationTypeDef, SnapshotPointer } from './observations/types.js';
import { ok, err } from './types.js';
import { compute_hash, concat_bytes, generate_version, stream_to_bytes } from './utils.js';
import { create_pointer, resolve_path, apply_span } from './observations/utils.js';

/**
 * Creates a typed Store instance bound to a Backend.
 * @category Core
 * @group Builders
 * 
 * Each store manages versioned snapshots of data with automatic deduplication:
 * when the same content is stored twice, only one copy of the data is kept
 * (identified by content hash), though separate metadata entries are created.
 * 
 * Stores are typically created via `create_corpus().with_store()` rather than
 * directly, which provides type-safe access through `corpus.stores.<id>`.
 * 
 * @param backend - The storage backend for persistence
 * @param definition - Store configuration including id and codec
 * @returns A Store instance for the specified type
 * 
 * @example
 * ```ts
 * const backend = create_memory_backend()
 * const users = define_store('users', json_codec(UserSchema))
 * const store = create_store(backend, users)
 * 
 * // Store a snapshot
 * const result = await store.put({ name: 'Alice', email: 'alice@example.com' })
 * if (result.ok) {
 *   console.log('Stored version:', result.value.version)
 * }
 * 
 * // Storing identical content reuses the same data_key (deduplication)
 * const result2 = await store.put({ name: 'Alice', email: 'alice@example.com' })
 * // result.value.data_key === result2.value.data_key (same content hash)
 * ```
 */
export function create_store<T>(backend: Backend, definition: StoreDefinition<string, T>): Store<T> {
  const { id, codec, data_key_fn } = definition

  function emit(event: Parameters<NonNullable<Backend['on_event']>>[0]) {
    backend.on_event?.(event)
  }

  function make_data_key(ctx: DataKeyContext): string {
    if (data_key_fn) {
      return data_key_fn(ctx)
    }
    return `${ctx.store_id}/${ctx.content_hash}`
  }

  async function do_put(bytes: Uint8Array, opts?: { parents?: SnapshotMeta['parents']; invoked_at?: Date; tags?: string[] }): Promise<Result<SnapshotMeta, CorpusError>> {
    const version = generate_version()
    const content_hash = await compute_hash(bytes)
    const key_ctx: DataKeyContext = { store_id: id, version, content_hash, tags: opts?.tags }

    // deduplication: reuse existing data_key if content already exists
    const existing = await backend.metadata.find_by_hash(id, content_hash)
    const deduplicated = existing !== null
    const data_key = deduplicated ? existing.data_key : make_data_key(key_ctx)

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
  }

  function build_handle(data_handle: DataHandle): SnapshotHandle<T> {
    const handle: any = {
      async value(): Promise<Result<T, CorpusError>> {
        const bytes = await data_handle.bytes()
        try {
          return ok(await codec.decode(bytes))
        } catch (cause) {
          const error: CorpusError = { kind: 'decode_error', cause: cause as Error }
          emit({ type: 'error', error })
          return err(error)
        }
      },
      async bytes(): Promise<Result<Uint8Array, CorpusError>> {
        return ok(await data_handle.bytes())
      },
    }

    if (codec.decode_stream) {
      const decode_stream = codec.decode_stream
      handle.stream = async (): Promise<Result<ReadableStream<T>, CorpusError>> => {
        try {
          return ok(decode_stream(data_handle.stream()))
        } catch (cause) {
          const error: CorpusError = { kind: 'decode_error', cause: cause as Error }
          emit({ type: 'error', error })
          return err(error)
        }
      }
    }

    return handle as SnapshotHandle<T>
  }

  async function get_handle_impl(version: string): Promise<Result<{ meta: SnapshotMeta; handle: SnapshotHandle<T> }, CorpusError>> {
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

    emit({ type: 'snapshot_get', store_id: id, version, found: true })
    return ok({ meta, handle: build_handle(data_result.value) })
  }

  async function get_latest_handle_impl(): Promise<Result<{ meta: SnapshotMeta; handle: SnapshotHandle<T> }, CorpusError>> {
    const meta_result = await backend.metadata.get_latest(id)
    if (!meta_result.ok) return meta_result

    const meta = meta_result.value
    const data_result = await backend.data.get(meta.data_key)
    if (!data_result.ok) {
      emit({ type: 'error', error: data_result.error })
      return data_result
    }

    return ok({ meta, handle: build_handle(data_result.value) })
  }

  async function put_stream_impl(stream: ReadableStream<T>, opts?: { parents?: SnapshotMeta['parents']; invoked_at?: Date; tags?: string[] }): Promise<Result<SnapshotMeta, CorpusError>> {
    if (!codec.encode_stream) {
      const error: CorpusError = { kind: 'invalid_config', message: 'codec does not support encode_stream' }
      emit({ type: 'error', error })
      return err(error)
    }

    let encoded: Uint8Array
    try {
      // codec.encode_stream takes a value (T), not a stream — so we adapt by encoding
      // each consumer-provided chunk independently and concatenating the byte outputs.
      // Per plan §2.6 option (c): buffer encoded output for hashing, since corpus
      // content-addresses by SHA-256 of the encoded bytes and there's no streaming
      // SHA-256 in the standard runtime.
      const encoded_chunks: Uint8Array[] = []
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        encoded_chunks.push(await stream_to_bytes(codec.encode_stream(value)))
      }
      encoded = concat_bytes(encoded_chunks)
    } catch (cause) {
      const error: CorpusError = { kind: 'encode_error', cause: cause as Error }
      emit({ type: 'error', error })
      return err(error)
    }

    return do_put(encoded, opts)
  }

  const store: any = {
    id,
    codec,

    async put(data: T, opts?: { parents?: SnapshotMeta['parents']; invoked_at?: Date; tags?: string[] }): Promise<Result<SnapshotMeta, CorpusError>> {
      let bytes: Uint8Array
      try {
        bytes = await codec.encode(data)
      } catch (cause) {
        const error: CorpusError = { kind: 'encode_error', cause: cause as Error }
        emit({ type: 'error', error })
        return err(error)
      }

      return do_put(bytes, opts)
    },

    async get(version: string): Promise<Result<{ meta: SnapshotMeta; data: T }, CorpusError>> {
      const handle_result = await get_handle_impl(version)
      if (!handle_result.ok) return handle_result

      const value_result = await handle_result.value.handle.value()
      if (!value_result.ok) return value_result

      return ok({ meta: handle_result.value.meta, data: value_result.value })
    },

    async get_latest(): Promise<Result<{ meta: SnapshotMeta; data: T }, CorpusError>> {
      const handle_result = await get_latest_handle_impl()
      if (!handle_result.ok) return handle_result

      const value_result = await handle_result.value.handle.value()
      if (!value_result.ok) return value_result

      return ok({ meta: handle_result.value.meta, data: value_result.value })
    },

    get_handle: get_handle_impl,
    get_latest_handle: get_latest_handle_impl,
    put_stream: put_stream_impl,

    async get_meta(version: string): Promise<Result<SnapshotMeta, CorpusError>> {
      return backend.metadata.get(id, version)
    },

    list(opts?: Parameters<Store<T>['list']>[0]) {
      return backend.metadata.list(id, opts)
    },

    async delete(version: string): Promise<Result<void, CorpusError>> {
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

  return store as Store<T>
}

/**
 * Creates a new Corpus instance using the builder pattern.
 * 
 * A Corpus is a collection of typed stores backed by a storage backend.
 * Use the builder chain to configure: `with_backend()` → `with_store()` → `build()`.
 * 
 * @category Core
 * @group Builders
 * @returns A CorpusBuilder to configure and build the Corpus
 * 
 * @example
 * ```ts
 * import { z } from 'zod'
 * 
 * const UserSchema = z.object({ name: z.string(), email: z.string() })
 * const users = define_store('users', json_codec(UserSchema))
 * const notes = define_store('notes', text_codec())
 * 
 * const corpus = create_corpus()
 *   .with_backend(create_memory_backend())
 *   .with_store(users)
 *   .with_store(notes)
 *   .build()
 * 
 * // Type-safe access to stores
 * await corpus.stores.users.put({ name: 'Alice', email: 'alice@example.com' })
 * await corpus.stores.notes.put('Hello, world!')
 * 
 * // With observations
 * const corpus_with_obs = create_corpus()
 *   .with_backend(create_memory_backend())
 *   .with_store(users)
 *   .with_observations([EntityType, SentimentType])
 *   .build()
 * 
 * // Pointer utilities
 * const pointer = corpus_with_obs.create_pointer('users', 'v123', '$.name')
 * const value = await corpus_with_obs.resolve_pointer(pointer)
 * ```
 */
export function create_corpus(): CorpusBuilder<{}> {
  let backend: Backend | null = null
  const definitions: StoreDefinition<string, any>[] = []
  let observation_types: ObservationTypeDef<unknown>[] = []

  const builder: CorpusBuilder<any> = {
    with_backend(b) {
      backend = b
      return builder
    },

    with_store(definition) {
      definitions.push(definition)
      return builder
    },

    with_observations(types) {
      observation_types = types
      return builder
    },

    build() {
      if (!backend) {
        throw new Error('Backend is required. Call with_backend() first.')
      }

      const b = backend
      
      const stores: Record<string, Store<any>> = {}
      for (const def of definitions) {
        stores[def.id] = create_store(b, def)
      }

      const observations_client = observation_types.length > 0 && 'observations' in b
        ? (b as Backend & { observations: ObservationsClient }).observations
        : undefined

      async function resolve_pointer_impl<T>(pointer: SnapshotPointer): Promise<Result<T, CorpusError>> {
        const store = stores[pointer.store_id]
        if (!store) {
          return err({ kind: 'not_found', store_id: pointer.store_id, version: pointer.version })
        }

        const snapshot_result = await store.get(pointer.version)
        if (!snapshot_result.ok) return snapshot_result

        let value: unknown = snapshot_result.value.data

        if (pointer.path) {
          const path_result = resolve_path(value, pointer.path)
          if (!path_result.ok) return path_result
          value = path_result.value
        }

        if (pointer.span && typeof value === 'string') {
          const span_result = apply_span(value, pointer.span)
          if (!span_result.ok) return span_result
          value = span_result.value
        }

        return ok(value as T)
      }

      async function is_superseded_impl(pointer: SnapshotPointer): Promise<boolean> {
        if (!observations_client?.is_stale) return false
        return observations_client.is_stale(pointer)
      }

      return {
        stores,
        metadata: b.metadata,
        data: b.data,
        observations: observations_client,
        create_pointer,
        resolve_pointer: resolve_pointer_impl,
        is_superseded: is_superseded_impl,
      } as Corpus<any>
    },
  }

  return builder as CorpusBuilder<{}>
}
