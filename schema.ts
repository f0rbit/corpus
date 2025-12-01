import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

export const corpus_snapshots = sqliteTable('corpus_snapshots', {
  store_id: text('store_id').notNull(),
  version: text('version').notNull(),
  parents: text('parents').notNull(),           // JSON array of ParentRef
  created_at: text('created_at').notNull(),     // ISO string
  invoked_at: text('invoked_at'),               // ISO string, nullable
  content_hash: text('content_hash').notNull(),
  content_type: text('content_type').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  tags: text('tags'),                           // JSON array, nullable
}, (table) => ({
  pk: primaryKey({ columns: [table.store_id, table.version] }),
  created_idx: index('idx_store_created').on(table.store_id, table.created_at),
  hash_idx: index('idx_content_hash').on(table.content_hash),
}))

// Type helper for selecting from the table
export type CorpusSnapshotRow = typeof corpus_snapshots.$inferSelect
export type CorpusSnapshotInsert = typeof corpus_snapshots.$inferInsert
