import { eq, and, desc, lt, gt, like, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { Backend, MetadataClient, DataClient, SnapshotMeta } from '../types'
import { corpus_snapshots } from '../schema'

type D1Database = { prepare: (sql: string) => unknown }
type R2Bucket = {
  get: (key: string) => Promise<{ body: ReadableStream<Uint8Array>; arrayBuffer: () => Promise<ArrayBuffer> } | null>
  put: (key: string, data: ReadableStream<Uint8Array> | Uint8Array) => Promise<void>
  delete: (key: string) => Promise<void>
}

export type CloudflareBackendConfig = {
  d1: D1Database
  r2: R2Bucket
}

export function create_cloudflare_backend(config: CloudflareBackendConfig): Backend {
  const db = drizzle(config.d1)
  const { r2 } = config

  function r2_key(store_id: string, version: string): string {
    return `${store_id}/${version}`
  }

  function row_to_meta(row: typeof corpus_snapshots.$inferSelect): SnapshotMeta {
    return {
      store_id: row.store_id,
      version: row.version,
      parents: JSON.parse(row.parents),
      created_at: new Date(row.created_at),
      invoked_at: row.invoked_at ? new Date(row.invoked_at) : undefined,
      content_hash: row.content_hash,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
    }
  }

  const metadata: MetadataClient = {
    async get(store_id, version) {
      const rows = await db
        .select()
        .from(corpus_snapshots)
        .where(and(
          eq(corpus_snapshots.store_id, store_id),
          eq(corpus_snapshots.version, version)
        ))
        .limit(1)
      
      const row = rows[0]
      if (!row) return null
      return row_to_meta(row)
    },

    async put(meta) {
      await db
        .insert(corpus_snapshots)
        .values({
          store_id: meta.store_id,
          version: meta.version,
          parents: JSON.stringify(meta.parents),
          created_at: meta.created_at.toISOString(),
          invoked_at: meta.invoked_at?.toISOString() ?? null,
          content_hash: meta.content_hash,
          content_type: meta.content_type,
          size_bytes: meta.size_bytes,
          tags: meta.tags ? JSON.stringify(meta.tags) : null,
        })
        .onConflictDoUpdate({
          target: [corpus_snapshots.store_id, corpus_snapshots.version],
          set: {
            parents: JSON.stringify(meta.parents),
            created_at: meta.created_at.toISOString(),
            invoked_at: meta.invoked_at?.toISOString() ?? null,
            content_hash: meta.content_hash,
            content_type: meta.content_type,
            size_bytes: meta.size_bytes,
            tags: meta.tags ? JSON.stringify(meta.tags) : null,
          },
        })
    },

    async delete(store_id, version) {
      await db
        .delete(corpus_snapshots)
        .where(and(
          eq(corpus_snapshots.store_id, store_id),
          eq(corpus_snapshots.version, version)
        ))
    },

    async *list(store_id, opts) {
      const conditions = [like(corpus_snapshots.store_id, `${store_id}%`)]
      
      if (opts?.before) {
        conditions.push(lt(corpus_snapshots.created_at, opts.before.toISOString()))
      }
      if (opts?.after) {
        conditions.push(gt(corpus_snapshots.created_at, opts.after.toISOString()))
      }

      let query = db
        .select()
        .from(corpus_snapshots)
        .where(and(...conditions))
        .orderBy(desc(corpus_snapshots.created_at))

      if (opts?.limit) {
        query = query.limit(opts.limit) as typeof query
      }

      const rows = await query

      for (const row of rows) {
        const meta = row_to_meta(row)
        
        if (opts?.tags?.length && !opts.tags.some(t => meta.tags?.includes(t))) {
          continue
        }
        
        yield meta
      }
    },

    async get_latest(store_id) {
      const rows = await db
        .select()
        .from(corpus_snapshots)
        .where(eq(corpus_snapshots.store_id, store_id))
        .orderBy(desc(corpus_snapshots.created_at))
        .limit(1)
      
      const row = rows[0]
      if (!row) return null
      return row_to_meta(row)
    },

    async *get_children(parent_store_id, parent_version) {
      const rows = await db
        .select()
        .from(corpus_snapshots)
        .where(
          sql`EXISTS (
            SELECT 1 FROM json_each(${corpus_snapshots.parents}) 
            WHERE json_extract(value, '$.store_id') = ${parent_store_id}
              AND json_extract(value, '$.version') = ${parent_version}
          )`
        )

      for (const row of rows) {
        yield row_to_meta(row)
      }
    },
  }

  const data: DataClient = {
    async get(store_id, version) {
      const object = await r2.get(r2_key(store_id, version))
      if (!object) return null

      const body = object.body

      return {
        stream: () => body,
        bytes: async () => new Uint8Array(await object.arrayBuffer()),
      }
    },

    async put(store_id, version, input) {
      await r2.put(r2_key(store_id, version), input)
    },

    async delete(store_id, version) {
      await r2.delete(r2_key(store_id, version))
    },
  }

  return { metadata, data }
}
