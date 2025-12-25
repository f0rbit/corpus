export { create_corpus, create_store } from "./corpus";

export { create_memory_backend, type MemoryBackendOptions } from "./backend/memory";
export { create_file_backend, type FileBackendConfig } from "./backend/file";
export { create_cloudflare_backend, type CloudflareBackendConfig } from "./backend/cloudflare";
export { create_layered_backend, type LayeredBackendOptions } from "./backend/layered";

export { json_codec, text_codec, binary_codec, compute_hash, generate_version } from "./utils";

export { corpus_snapshots, type CorpusSnapshotRow, type CorpusSnapshotInsert } from "./schema";

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
} from "./types";

export { ok, err, define_store } from "./types";

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
	type FetchError,
	type Pipe,
} from "./result";

export { Semaphore, parallel_map } from "./concurrency";

export * from "./observations";

export { createCorpusInfra, CORPUS_MIGRATION_SQL, type CorpusInfra, type CorpusInfraConfig } from "./sst";
