import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core'

export const corpus_snapshots = sqliteTable('corpus_snapshots', {
  store_id: text('store_id').notNull(),
  version: text('version').notNull(),
  parents: text('parents').notNull(),
  created_at: text('created_at').notNull(),
  invoked_at: text('invoked_at'),
  content_hash: text('content_hash').notNull(),
  content_type: text('content_type').notNull(),
  size_bytes: integer('size_bytes').notNull(),
  data_key: text('data_key').notNull(),
  tags: text('tags'),
}, (table) => ({
  pk: primaryKey({ columns: [table.store_id, table.version] }),
  created_idx: index('idx_store_created').on(table.store_id, table.created_at),
  hash_idx: index('idx_content_hash').on(table.store_id, table.content_hash),
  data_key_idx: index('idx_data_key').on(table.data_key),
}))

export type CorpusSnapshotRow = typeof corpus_snapshots.$inferSelect
export type CorpusSnapshotInsert = typeof corpus_snapshots.$inferInsert
