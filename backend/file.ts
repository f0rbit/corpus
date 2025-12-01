import type { Backend, MetadataClient, DataClient, SnapshotMeta, DataHandle, ListOpts } from '../types'
import { mkdir, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export type FileBackendConfig = {
  base_path: string
}

export function create_file_backend(config: FileBackendConfig): Backend {
  const { base_path } = config
  const meta_path = join(base_path, '_metadata.json')
  
  function data_path(store_id: string, version: string): string {
    return join(base_path, store_id, `${version}.bin`)
  }

  function make_key(store_id: string, version: string): string {
    return `${store_id}:${version}`
  }

  async function read_all_meta(): Promise<Map<string, SnapshotMeta>> {
    const file = Bun.file(meta_path)
    if (!await file.exists()) return new Map()
    
    const content = await file.text()
    const entries = JSON.parse(content, (key, value) => {
      if (key === 'created_at' || key === 'invoked_at') {
        return value ? new Date(value) : value
      }
      return value
    }) as [string, SnapshotMeta][]
    return new Map(entries)
  }

  async function write_all_meta(meta_store: Map<string, SnapshotMeta>): Promise<void> {
    await mkdir(dirname(meta_path), { recursive: true })
    const entries = Array.from(meta_store.entries())
    await Bun.write(meta_path, JSON.stringify(entries))
  }

  const metadata: MetadataClient = {
    async get(store_id, version) {
      const all = await read_all_meta()
      return all.get(make_key(store_id, version)) ?? null
    },

    async put(meta) {
      const all = await read_all_meta()
      all.set(make_key(meta.store_id, meta.version), meta)
      await write_all_meta(all)
    },

    async delete(store_id, version) {
      const all = await read_all_meta()
      all.delete(make_key(store_id, version))
      await write_all_meta(all)
    },

    async *list(store_id, opts) {
      const all = await read_all_meta()
      const prefix = `${store_id}:`
      
      const matches = Array.from(all.entries())
        .filter(([key]) => key.startsWith(prefix))
        .map(([, meta]) => meta)
        .filter(meta => {
          if (opts?.before && meta.created_at >= opts.before) return false
          if (opts?.after && meta.created_at <= opts.after) return false
          if (opts?.tags?.length && !opts.tags.some(t => meta.tags?.includes(t))) return false
          return true
        })
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      
      const limit = opts?.limit ?? Infinity
      for (const meta of matches.slice(0, limit)) {
        yield meta
      }
    },

    async get_latest(store_id) {
      for await (const meta of this.list(store_id, { limit: 1 })) {
        return meta
      }
      return null
    },

    async *get_children(parent_store_id, parent_version) {
      const all = await read_all_meta()
      const children = Array.from(all.values()).filter(meta =>
        meta.parents.some(p => p.store_id === parent_store_id && p.version === parent_version)
      )
      for (const meta of children) {
        yield meta
      }
    },
  }

  const data: DataClient = {
    async get(store_id, version) {
      const file_path = data_path(store_id, version)
      const file = Bun.file(file_path)
      
      if (!await file.exists()) return null

      return {
        stream: () => file.stream(),
        bytes: async () => new Uint8Array(await file.arrayBuffer()),
      }
    },

    async put(store_id, version, input) {
      const file_path = data_path(store_id, version)
      await mkdir(dirname(file_path), { recursive: true })
      
      if (input instanceof Uint8Array) {
        await Bun.write(file_path, input)
        return
      }

      const chunks: Uint8Array[] = []
      const reader = input.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const bytes = concat_bytes(chunks)
      await Bun.write(file_path, bytes)
    },

    async delete(store_id, version) {
      const file_path = data_path(store_id, version)
      const file = Bun.file(file_path)
      if (await file.exists()) {
        await unlink(file_path).catch(() => {})
      }
    },
  }

  return { metadata, data }
}

function concat_bytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
