export { create_corpus } from './corpus'
export { create_store } from './store'

export { create_memory_backend, type MemoryBackendOptions } from './backend/memory'
export { create_file_backend, type FileBackendConfig } from './backend/file'
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare'

export { json_codec, text_codec, binary_codec } from './codec'

export { corpus_snapshots, type CorpusSnapshotRow, type CorpusSnapshotInsert } from './schema'

export { compute_hash } from './hash'
export { generate_version } from './version'

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

export { createCorpusInfra, CORPUS_MIGRATION_SQL, type CorpusInfra, type CorpusInfraConfig } from './sst'
