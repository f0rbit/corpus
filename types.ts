import type { ZodSchema } from "zod";
export type ContentType =
	| "application/json"
	| "text/plain"
	| "text/xml"
	| "image/png"
	| "image/jpeg"
	| "application/octet-stream"
	| (string & {});
export type ParentRef = {
	store_id: string; // e.g., "twitter/timelines"
	version: string;
	role?: string;
};
export type SnapshotMeta = {
	store_id: string; // e.g., "twitter/timelines" or "analysis/weekly"
	version: string; // e.g., "2024-01-15" or "v1.2.3"

	parents: ParentRef[];

	created_at: Date;
	invoked_at?: Date;

	content_hash: string;
	content_type: ContentType;
	size_bytes: number;

	tags?: string[];
};
export type Snapshot<T = unknown> = {
	meta: SnapshotMeta;
	data: T;
};
export type DataHandle = {
	stream: () => ReadableStream<Uint8Array>;
	bytes: () => Promise<Uint8Array>;
};
export type MetadataClient = {
	get: (store_id: string, version: string) => Promise<SnapshotMeta | null>;
	put: (meta: SnapshotMeta) => Promise<void>;
	delete: (store_id: string, version: string) => Promise<void>;

	list: (store_id: string, opts?: ListOpts) => AsyncIterable<SnapshotMeta>;
	get_latest: (store_id: string) => Promise<SnapshotMeta | null>;
	get_children: (
		parent_store_id: string,
		parent_version: string,
	) => AsyncIterable<SnapshotMeta>;
};
export type DataClient = {
	get: (store_id: string, version: string) => Promise<DataHandle | null>;
	put: (
		store_id: string,
		version: string,
		data: ReadableStream<Uint8Array> | Uint8Array,
	) => Promise<void>;
	delete: (store_id: string, version: string) => Promise<void>;
};
export type ListOpts = {
	limit?: number;
	cursor?: string;
	before?: Date;
	after?: Date;
	tags?: string[];
};
export type Backend = {
	metadata: MetadataClient;
	data: DataClient;
};
export type Codec<T> = {
	content_type: ContentType;
	encode: (value: T) => Uint8Array;
	decode: (bytes: Uint8Array) => T;
};
export type StoreConfig<T = unknown> = {
	id: string; // e.g., "twitter/timelines"
	description?: string;
	codec: Codec<T>;
};
export type Store<T> = {
	id: string;
	codec: Codec<T>;

	put: (version: string, data: T, opts?: PutOpts) => Promise<SnapshotMeta>;
	get: (version: string) => Promise<Snapshot<T> | null>;
	get_latest: () => Promise<Snapshot<T> | null>;
	get_meta: (version: string) => Promise<SnapshotMeta | null>;
	list: (opts?: ListOpts) => AsyncIterable<SnapshotMeta>;
	delete: (version: string) => Promise<void>;
};
export type PutOpts = {
	parents?: ParentRef[];
	invoked_at?: Date;
	tags?: string[];
};
export type CorpusBuilder = {
	with_backend: (backend: Backend) => CorpusBuilder;
	with_store: <T>(config: StoreConfig<T>) => CorpusBuilder;
	build: () => Corpus;
};
export type Corpus = {
	store: <T>(id: string) => Store<T>;
	metadata: MetadataClient;
	data: DataClient;
};
