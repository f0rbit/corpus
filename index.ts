export { create_corpus, create_store } from './corpus.js';

export { create_memory_backend, type MemoryBackendOptions } from './backend/memory.js';
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare.js';
export { create_layered_backend, type LayeredBackendOptions } from './backend/layered.js';

export { json_codec, text_codec, binary_codec, compute_hash, generate_version } from './utils.js';

export { corpus_snapshots, type CorpusSnapshotRow, type CorpusSnapshotInsert } from './schema.js';

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
	Parser,
	Store,
	StoreDefinition,
	DefineStoreOpts,
	DataKeyContext,
	PutOpts,
	CorpusBuilder,
	Corpus,
	CorpusError,
	Result,
	CorpusEvent,
	EventHandler,
	ObservationsClient,
} from './types.js';

export { ok, err, define_store } from './types.js';

export {
	match,
	unwrap_or,
	unwrap,
	unwrap_err,
	try_catch,
	try_catch_async,
	fetch_result,
	pipe,
	to_nullable,
	to_fallback,
	null_on,
	fallback_on,
	format_error,
	at,
	first,
	last,
	merge_deep,
	type DeepPartial,
	type FetchError,
	type Pipe,
} from './result.js';

export { Semaphore, parallel_map } from './concurrency.js';

export * from './observations/index.js';

export { createCorpusInfra, CORPUS_MIGRATION_SQL, type CorpusInfra, type CorpusInfraConfig } from './sst.js';
