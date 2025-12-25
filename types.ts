/**
 * @module Types
 * @description Type definitions for the corpus library.
 */

import type {
  SnapshotPointer,
  Observation,
  ObservationMeta,
  ObservationTypeDef,
  ObservationPutOpts,
  ObservationQueryOpts
} from './observations/types'

/**
 * Error types that can occur during Corpus operations.
 * @category Types
 * @group Error Types
 * 
 * Uses discriminated unions for type-safe error handling via the `kind` field:
 * - `not_found` - Requested snapshot or data does not exist
 * - `already_exists` - Attempted to create a snapshot that already exists
 * - `storage_error` - Backend storage operation failed (includes cause and operation name)
 * - `decode_error` - Failed to decode data using the store's codec
 * - `encode_error` - Failed to encode data using the store's codec
 * - `hash_mismatch` - Content hash verification failed (data corruption)
 * - `invalid_config` - Configuration error during setup
 * 
 * @example
 * ```ts
 * const result = await store.get('nonexistent')
 * if (!result.ok) {
 *   switch (result.error.kind) {
 *     case 'not_found':
 *       console.log(`Version ${result.error.version} not found`)
 *       break
 *     case 'storage_error':
 *       console.log(`Storage failed during ${result.error.operation}:`, result.error.cause)
 *       break
 *   }
 * }
 * ```
 */
export type CorpusError =
  | { kind: 'not_found'; store_id: string; version: string }
  | { kind: 'already_exists'; store_id: string; version: string }
  | { kind: 'storage_error'; cause: Error; operation: string }
  | { kind: 'decode_error'; cause: Error }
  | { kind: 'encode_error'; cause: Error }
  | { kind: 'hash_mismatch'; expected: string; actual: string }
  | { kind: 'invalid_config'; message: string }
  | { kind: 'validation_error'; cause: Error; message: string }
  | { kind: 'observation_not_found'; id: string }

/**
 * A discriminated union representing either success or failure.
 * @category Types
 * @group Result Types
 */
export type Result<T, E = CorpusError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

/**
 * Creates a successful Result containing a value.
 * 
 * @category Core
 * @group Result Helpers
 * @param value - The success value to wrap
 * @returns A Result with `ok: true` and the value
 * 
 * @example
 * ```ts
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return err('Division by zero')
 *   return ok(a / b)
 * }
 * 
 * const result = divide(10, 2)
 * if (result.ok) {
 *   console.log(result.value) // 5
 * }
 * ```
 */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })

/**
 * Creates a failed Result containing an error.
 * 
 * @category Core
 * @group Result Helpers
 * @param error - The error to wrap
 * @returns A Result with `ok: false` and the error
 * 
 * @example
 * ```ts
 * function parsePositive(s: string): Result<number, string> {
 *   const n = parseInt(s, 10)
 *   if (isNaN(n)) return err('Not a number')
 *   if (n <= 0) return err('Must be positive')
 *   return ok(n)
 * }
 * ```
 */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export type CorpusEvent =
  | { type: 'meta_get'; store_id: string; version: string; found: boolean }
  | { type: 'meta_put'; store_id: string; version: string }
  | { type: 'meta_delete'; store_id: string; version: string }
  | { type: 'meta_list'; store_id: string; count: number }
  | { type: 'data_get'; store_id: string; version: string; found: boolean }
  | { type: 'data_put'; store_id: string; version: string; size_bytes: number; deduplicated: boolean }
  | { type: 'data_delete'; store_id: string; version: string }
  | { type: 'snapshot_put'; store_id: string; version: string; content_hash: string; deduplicated: boolean }
  | { type: 'snapshot_get'; store_id: string; version: string; found: boolean }
  | { type: 'error'; error: CorpusError }

export type EventHandler = (event: CorpusEvent) => void

export type ContentType =
  | "application/json"
  | "text/plain"
  | "text/xml"
  | "image/png"
  | "image/jpeg"
  | "application/octet-stream"
  | (string & {})

export type ParentRef = {
  store_id: string
  version: string
  role?: string
}

/**
 * Metadata about a stored snapshot (without the actual data).
 * 
 * Key fields:
 * - `store_id` - Which store this snapshot belongs to
 * - `version` - Unique, time-sortable identifier for this snapshot
 * - `content_hash` - SHA-256 hash of the encoded data (enables deduplication)
 * - `data_key` - Key to retrieve the actual data from the backend
 * - `parents` - Links to parent snapshots for building data lineage graphs
 * - `tags` - Optional labels for filtering and organization
 * 
 * @category Types
 * @group Snapshot Types
 * @example
 * ```ts
 * const result = await store.put(data, {
 *   parents: [{ store_id: 'source', version: 'abc123' }],
 *   tags: ['draft', 'reviewed']
 * })
 * 
 * if (result.ok) {
 *   const meta = result.value
 *   console.log(`Stored ${meta.size_bytes} bytes as version ${meta.version}`)
 * }
 * ```
 */
export type SnapshotMeta = {
  store_id: string
  version: string
  parents: ParentRef[]
  created_at: Date
  invoked_at?: Date
  content_hash: string
  content_type: ContentType
  size_bytes: number
  data_key: string
  tags?: string[]
}

export type Snapshot<T = unknown> = {
  meta: SnapshotMeta
  data: T
}

/** @internal */
export type DataHandle = {
  stream: () => ReadableStream<Uint8Array>
  bytes: () => Promise<Uint8Array>
}

/** @internal */
export type MetadataClient = {
  get: (store_id: string, version: string) => Promise<Result<SnapshotMeta, CorpusError>>
  put: (meta: SnapshotMeta) => Promise<Result<void, CorpusError>>
  delete: (store_id: string, version: string) => Promise<Result<void, CorpusError>>
  list: (store_id: string, opts?: ListOpts) => AsyncIterable<SnapshotMeta>
  get_latest: (store_id: string) => Promise<Result<SnapshotMeta, CorpusError>>
  get_children: (parent_store_id: string, parent_version: string) => AsyncIterable<SnapshotMeta>
  find_by_hash: (store_id: string, content_hash: string) => Promise<SnapshotMeta | null>
}

/** @internal */
export type DataClient = {
  get: (data_key: string) => Promise<Result<DataHandle, CorpusError>>
  put: (data_key: string, data: ReadableStream<Uint8Array> | Uint8Array) => Promise<Result<void, CorpusError>>
  delete: (data_key: string) => Promise<Result<void, CorpusError>>
  exists: (data_key: string) => Promise<boolean>
}

export type ListOpts = {
  limit?: number
  cursor?: string
  before?: Date
  after?: Date
  tags?: string[]
}

/**
 * Interface that storage backends implement.
 * 
 * A Backend provides two clients:
 * - `metadata` - For storing/retrieving snapshot metadata (versions, hashes, etc.)
 * - `data` - For storing/retrieving the actual binary content
 * 
 * Built-in backends:
 * - `create_memory_backend()` - In-memory, ephemeral storage
 * - `create_file_backend()` - Local filesystem persistence
 * - `create_cloudflare_backend()` - Cloudflare D1 + R2
 * - `create_layered_backend()` - Combines multiple backends
 * 
 * @category Types
 * @group Backend Types
 * @example
 * ```ts
 * // Custom backend implementation
 * const myBackend: Backend = {
 *   metadata: { get, put, delete, list, get_latest, get_children, find_by_hash },
 *   data: { get, put, delete, exists },
 *   on_event: (event) => console.log('Event:', event.type)
 * }
 * ```
 */
export type Backend = {
  metadata: MetadataClient
  data: DataClient
  observations?: ObservationsClient
  on_event?: EventHandler
}

/**
 * Serialization interface for encoding/decoding store data.
 * 
 * A Codec converts between typed values and binary data:
 * - `encode` - Converts a value to bytes for storage
 * - `decode` - Converts bytes back to a typed value
 * - `content_type` - MIME type stored in metadata
 * 
 * Built-in codecs:
 * - `json_codec(schema)` - JSON with Zod validation on decode
 * - `text_codec()` - Plain UTF-8 text
 * - `binary_codec()` - Raw binary pass-through
 * 
 * @category Types
 * @group Codec Types
 * @example
 * ```ts
 * // Custom codec for MessagePack
 * const msgpack_codec = <T>(schema: ZodSchema<T>): Codec<T> => ({
 *   content_type: 'application/msgpack',
 *   encode: (value) => encode(value),
 *   decode: (bytes) => schema.parse(decode(bytes))
 * })
 * ```
 */
export type Codec<T> = {
  content_type: ContentType
  encode: (value: T) => Uint8Array
  decode: (bytes: Uint8Array) => T
}

/**
 * Structural type for schema validators (Zod, Valibot, or custom).
 * 
 * Any object with a `parse(data: unknown) => T` method satisfies this interface.
 * Used by `json_codec()` to validate data on decode without importing a specific library.
 * 
 * @category Types
 * @group Codec Types
 * @example
 * ```ts
 * import { z } from 'zod'
 * 
 * // Zod schemas satisfy Parser<T>
 * const UserSchema = z.object({ name: z.string() })
 * const codec = json_codec(UserSchema) // works!
 * 
 * // Custom parsers work too
 * const myParser: Parser<number> = {
 *   parse: (data) => {
 *     if (typeof data !== 'number') throw new Error('Expected number')
 *     return data
 *   }
 * }
 * ```
 */
export type Parser<T> = { parse: (data: unknown) => T }

/**
 * A typed store for managing versioned data snapshots.
 * 
 * Stores provide the main API for reading and writing data:
 * - `put(data, opts?)` - Store a new snapshot, returns metadata with version
 * - `get(version)` - Retrieve a specific snapshot by version
 * - `get_latest()` - Get the most recent snapshot
 * - `get_meta(version)` - Get just the metadata (without data)
 * - `list(opts?)` - Iterate over snapshot metadata with filtering
 * - `delete(version)` - Remove a snapshot's metadata
 * 
 * Stores automatically deduplicate: storing the same content twice creates
 * two metadata entries pointing to the same underlying data.
 * 
 * @category Types
 * @group Store Types
 */
export type Store<T> = {
  readonly id: string
  readonly codec: Codec<T>
  put: (data: T, opts?: PutOpts) => Promise<Result<SnapshotMeta, CorpusError>>
  get: (version: string) => Promise<Result<Snapshot<T>, CorpusError>>
  get_latest: () => Promise<Result<Snapshot<T>, CorpusError>>
  get_meta: (version: string) => Promise<Result<SnapshotMeta, CorpusError>>
  list: (opts?: ListOpts) => AsyncIterable<SnapshotMeta>
  delete: (version: string) => Promise<Result<void, CorpusError>>
}

export type PutOpts = {
  parents?: ParentRef[]
  invoked_at?: Date
  tags?: string[]
}

/**
 * Context passed to data_key_fn for generating custom storage paths.
 * @internal
 */
export type DataKeyContext = {
  store_id: string
  version: string
  content_hash: string
  tags?: string[]
}

export type StoreDefinition<Id extends string, T> = {
  id: Id
  codec: Codec<T>
  description?: string
  /** Custom function to generate data_key (storage path). If not provided, uses `store_id/content_hash`. */
  data_key_fn?: (ctx: DataKeyContext) => string
}

export type DefineStoreOpts = {
  description?: string
  /** Custom function to generate data_key (storage path). If not provided, uses `store_id/content_hash`. */
  data_key_fn?: (ctx: DataKeyContext) => string
}

/**
 * Helper to define a type-safe store definition.
 * 
 * The `id` becomes the key in `corpus.stores`, providing type-safe access
 * to the store after building the corpus.
 * 
 * @category Core
 * @group Helpers
 * @param id - Unique identifier for the store (becomes the key in corpus.stores)
 * @param codec - Serialization codec for the store's data type
 * @param opts - Optional configuration (description, custom data_key_fn)
 * @returns A StoreDefinition to pass to `create_corpus().with_store()`
 * 
 * @example
 * ```ts
 * import { z } from 'zod'
 * 
 * const PostSchema = z.object({
 *   title: z.string(),
 *   body: z.string(),
 *   published: z.boolean()
 * })
 * 
 * const posts = define_store('posts', json_codec(PostSchema), { description: 'Blog posts' })
 * 
 * // With custom path generation based on tags
 * const hansard = define_store('hansard', text_codec(), {
 *   data_key_fn: (ctx) => {
 *     const date = ctx.tags?.find(t => t.startsWith('date:'))?.slice(5) ?? 'unknown'
 *     return `australia-house/raw/${date}/${ctx.version}`
 *   }
 * })
 * 
 * const corpus = create_corpus()
 *   .with_backend(backend)
 *   .with_store(posts)
 *   .build()
 * 
 * // Type-safe: corpus.stores.posts expects Post type
 * await corpus.stores.posts.put({ title: 'Hello', body: '...', published: true })
 * ```
 */
export function define_store<Id extends string, T>(
  id: Id,
  codec: Codec<T>,
  opts?: DefineStoreOpts | string
): StoreDefinition<Id, T> {
  // Support old signature: define_store(id, codec, description)
  if (typeof opts === 'string') {
    return { id, codec, description: opts }
  }
  return { id, codec, description: opts?.description, data_key_fn: opts?.data_key_fn }
}

/** @internal */
export type CorpusBuilder<Stores extends Record<string, Store<any>> = {}> = {
  with_backend: (backend: Backend) => CorpusBuilder<Stores>
  with_store: <Id extends string, T>(
    definition: StoreDefinition<Id, T>
  ) => CorpusBuilder<Stores & Record<Id, Store<T>>>
  with_observations: (types: ObservationTypeDef<unknown>[]) => CorpusBuilder<Stores>
  build: () => Corpus<Stores>
}

export type Corpus<Stores extends Record<string, Store<any>> = Record<string, Store<any>>> = {
  stores: Stores
  metadata: MetadataClient
  data: DataClient
  observations?: ObservationsClient
  create_pointer: (store_id: string, version: string, path?: string, span?: { start: number; end: number }) => SnapshotPointer
  resolve_pointer: <T>(pointer: SnapshotPointer) => Promise<Result<T, CorpusError>>
  is_superseded: (pointer: SnapshotPointer) => Promise<boolean>
}

/**
 * Client interface for managing observations.
 * 
 * Observations are structured facts that point back to specific locations
 * in versioned content. The ObservationsClient provides CRUD operations
 * with type-safe validation via ObservationTypeDef schemas.
 * 
 * Key operations:
 * - `put` - Create a new observation with validated content
 * - `get` - Retrieve a single observation by ID
 * - `query` / `query_meta` - Filter observations with various criteria
 * - `delete` / `delete_by_source` - Remove observations
 * - `is_stale` - Check if source content has been superseded
 * 
 * @category Types
 * @group Observation Types
 * 
 * @example
 * ```ts
 * // Define observation type
 * const entity_mention = define_observation_type('entity_mention', EntitySchema)
 * 
 * // Create observation
 * const result = await observations.put(entity_mention, {
 *   source: { store_id: 'hansard', version: 'abc123', path: '$.speeches[0]' },
 *   content: { entity: 'Climate Change', entity_type: 'topic' },
 *   confidence: 0.95
 * })
 * 
 * // Query observations
 * for await (const obs of observations.query({ type: 'entity_mention' })) {
 *   console.log(obs.content)
 * }
 * ```
 */
export type ObservationsClient = {
  put: <T>(type: ObservationTypeDef<T>, opts: ObservationPutOpts<T>) => Promise<Result<Observation<T>, CorpusError>>
  get: (id: string) => Promise<Result<Observation, CorpusError>>
  query: (opts?: ObservationQueryOpts) => AsyncIterable<Observation>
  query_meta: (opts?: ObservationQueryOpts) => AsyncIterable<ObservationMeta>
  delete: (id: string) => Promise<Result<void, CorpusError>>
  delete_by_source: (source: SnapshotPointer) => Promise<Result<number, CorpusError>>
  is_stale: (pointer: SnapshotPointer) => Promise<boolean>
}
