// Core
export { create_corpus } from './corpus'
export { create_store } from './store'

// Backends
export { create_memory_backend } from './backend/memory'
export { create_file_backend, type FileBackendConfig } from './backend/file'
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare'

// Codecs
export { json_codec, text_codec, binary_codec } from './codec'

// Schema (for Drizzle/D1)
export { corpus_snapshots, type CorpusSnapshotRow, type CorpusSnapshotInsert } from './schema'

// Utilities
export { compute_hash } from './hash'

// Types
export type {
  ContentType,
  ParentRef,
  SnapshotMeta,
  Snapshot,
  DataHandle,
  MetadataClient,
  DataClient,
  ListOpts,
  Backend,
  Codec,
  StoreConfig,
  Store,
  PutOpts,
  CorpusBuilder,
  Corpus,
} from './types'
