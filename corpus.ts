import type { Backend, Corpus, CorpusBuilder, StoreDefinition, Store } from './types'
import { create_store } from './store'

export function create_corpus(): CorpusBuilder<{}> {
  let backend: Backend | null = null
  const definitions: StoreDefinition<string, any>[] = []

  const builder: CorpusBuilder<any> = {
    with_backend(b) {
      backend = b
      return builder
    },

    with_store(definition) {
      definitions.push(definition)
      return builder
    },

    build() {
      if (!backend) {
        throw new Error('Backend is required. Call with_backend() first.')
      }

      const b = backend
      
      const stores: Record<string, Store<any>> = {}
      for (const def of definitions) {
        stores[def.id] = create_store(b, def)
      }

      return {
        stores,
        metadata: b.metadata,
        data: b.data,
      } as Corpus<any>
    },
  }

  return builder as CorpusBuilder<{}>
}
