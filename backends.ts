/**
 * Storage backend implementations for different environments.
 * @module Backends
 * @packageDocumentation
 */

export { create_memory_backend, type MemoryBackendOptions } from './backend/memory'
export { create_file_backend, type FileBackendConfig } from './backend/file'
export { create_cloudflare_backend, type CloudflareBackendConfig } from './backend/cloudflare'
export { create_layered_backend, type LayeredBackendOptions } from './backend/layered'
export type { Backend, MetadataClient, DataClient, DataHandle, EventHandler, CorpusEvent } from './types'
