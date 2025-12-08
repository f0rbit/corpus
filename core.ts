/**
 * Core corpus functionality for creating and managing versioned data stores.
 * @module Core
 * @packageDocumentation
 */

export { create_corpus, create_store } from './corpus'
export { define_store, ok, err } from './types'
export type {
  Corpus,
  CorpusBuilder,
  Store,
  StoreDefinition,
  Result,
  CorpusError,
  PutOpts,
} from './types'
