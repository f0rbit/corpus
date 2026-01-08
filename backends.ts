/**
 * Storage backend implementations for different environments.
 * @module Backends
 * @packageDocumentation
 */

export { create_memory_backend, type MemoryBackendOptions } from './backend/memory.js';
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare.js';
export { create_layered_backend, type LayeredBackendOptions } from './backend/layered.js';
export { create_metadata_client, create_data_client, type MetadataStorage, type DataStorage } from './backend/base.js';
export type { Backend, MetadataClient, DataClient, DataHandle, EventHandler, CorpusEvent } from './types.js';
