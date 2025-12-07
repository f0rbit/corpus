/**
 * Cloudflare Workers compatible exports
 * This entry point excludes the file backend which uses Node.js APIs
 */

export { create_corpus, create_store } from './corpus'

export { create_memory_backend, type MemoryBackendOptions } from './backend/memory'
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare'

export { json_codec, text_codec, binary_codec, compute_hash, generate_version } from './utils'

export { corpus_snapshots, type CorpusSnapshotRow, type CorpusSnapshotInsert } from './schema'

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
  Store,
  StoreDefinition,
  PutOpts,
  CorpusBuilder,
  Corpus,
  CorpusError,
  Result,
  CorpusEvent,
  EventHandler,
} from './types'

export { ok, err, define_store } from './types'
