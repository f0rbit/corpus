import type { Backend, Corpus, CorpusBuilder, StoreConfig, Store } from './types'
import { create_store } from './store'

export function create_corpus(): CorpusBuilder {
  let backend: Backend | null = null
  // Store configs with their codecs - we use `any` internally and cast on retrieval
  const stores = new Map<string, StoreConfig<any>>()

  const builder: CorpusBuilder = {
    with_backend(b) {
      backend = b
      return builder
    },

    with_store<T>(config: StoreConfig<T>) {
      stores.set(config.id, config)
      return builder
    },

    build(): Corpus {
      if (!backend) {
        throw new Error('Backend is required. Call with_backend() first.')
      }

      const b = backend

      return {
        metadata: b.metadata,
        data: b.data,

        store<T>(id: string): Store<T> {
          const config = stores.get(id)
          if (!config) {
            throw new Error(`Store "${id}" not registered. Call with_store() first.`)
          }
          // The config was stored with the correct codec type via with_store<T>
          return create_store<T>(b, config as StoreConfig<T>)
        },
      }
    },
  }

  return builder
}
