export type CorpusError =
  | { kind: 'not_found'; store_id: string; version: string }
  | { kind: 'already_exists'; store_id: string; version: string }
  | { kind: 'storage_error'; cause: Error; operation: string }
  | { kind: 'decode_error'; cause: Error }
  | { kind: 'encode_error'; cause: Error }
  | { kind: 'hash_mismatch'; expected: string; actual: string }
  | { kind: 'invalid_config'; message: string }

export type Result<T, E = CorpusError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
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

export type DataHandle = {
  stream: () => ReadableStream<Uint8Array>
  bytes: () => Promise<Uint8Array>
}

export type MetadataClient = {
  get: (store_id: string, version: string) => Promise<Result<SnapshotMeta, CorpusError>>
  put: (meta: SnapshotMeta) => Promise<Result<void, CorpusError>>
  delete: (store_id: string, version: string) => Promise<Result<void, CorpusError>>
  list: (store_id: string, opts?: ListOpts) => AsyncIterable<SnapshotMeta>
  get_latest: (store_id: string) => Promise<Result<SnapshotMeta, CorpusError>>
  get_children: (parent_store_id: string, parent_version: string) => AsyncIterable<SnapshotMeta>
  find_by_hash: (store_id: string, content_hash: string) => Promise<SnapshotMeta | null>
}

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

export type Backend = {
  metadata: MetadataClient
  data: DataClient
  on_event?: EventHandler
}

export type Codec<T> = {
  content_type: ContentType
  encode: (value: T) => Uint8Array
  decode: (bytes: Uint8Array) => T
}

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

export type StoreDefinition<Id extends string, T> = {
  id: Id
  codec: Codec<T>
  description?: string
}

export function define_store<Id extends string, T>(
  id: Id,
  codec: Codec<T>,
  description?: string
): StoreDefinition<Id, T> {
  return { id, codec, description }
}

export type CorpusBuilder<Stores extends Record<string, Store<any>> = {}> = {
  with_backend: (backend: Backend) => CorpusBuilder<Stores>
  with_store: <Id extends string, T>(
    definition: StoreDefinition<Id, T>
  ) => CorpusBuilder<Stores & Record<Id, Store<T>>>
  build: () => Corpus<Stores>
}

export type Corpus<Stores extends Record<string, Store<any>> = Record<string, Store<any>>> = {
  stores: Stores
  metadata: MetadataClient
  data: DataClient
}
