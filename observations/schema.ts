/**
 * @module ObservationSchema
 * @description Database schema definitions for observations using Drizzle ORM.
 */

import { sqliteTable, text, real, index } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle ORM schema for the corpus_observations table.
 * 
 * Used by the Cloudflare backend with D1 (SQLite). Defines the table structure
 * for storing observation metadata linking structured facts to versioned content.
 * 
 * Columns:
 * - `id` - Primary key (unique observation identifier)
 * - `type` - Observation type name (e.g., 'entity_mention')
 * - `source_store_id` + `source_version` - Points to the snapshot this observation is about
 * - `source_path` - Optional JSONPath expression to specific element
 * - `source_span_start` / `source_span_end` - Optional character range within text
 * - `content` - JSON-encoded observation data
 * - `confidence` - Optional confidence score (0.0 to 1.0)
 * - `observed_at` - When the observation was made (ISO 8601)
 * - `created_at` - When the record was stored (ISO 8601)
 * - `derived_from` - Optional JSON array of SnapshotPointers for provenance
 * 
 * @example
 * ```ts
 * import { drizzle } from 'drizzle-orm/d1'
 * import { corpus_observations } from 'corpus/observation-schema'
 * 
 * const db = drizzle(env.D1)
 * const rows = await db.select().from(corpus_observations).where(eq(corpus_observations.type, 'entity_mention'))
 * ```
 */
export const corpus_observations = sqliteTable('corpus_observations', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  
  // Source pointer
  source_store_id: text('source_store_id').notNull(),
  source_version: text('source_version').notNull(),
  source_path: text('source_path'),
  source_span_start: text('source_span_start'),
  source_span_end: text('source_span_end'),
  
  // Content
  content: text('content').notNull(),
  confidence: real('confidence'),
  
  // Timestamps
  observed_at: text('observed_at'),
  created_at: text('created_at').notNull(),
  
  // Derivation lineage
  derived_from: text('derived_from'),
}, (table) => ({
  type_idx: index('idx_obs_type').on(table.type),
  source_idx: index('idx_obs_source').on(table.source_store_id, table.source_version),
  type_observed_idx: index('idx_obs_type_observed').on(table.type, table.observed_at),
  type_source_idx: index('idx_obs_type_source').on(table.type, table.source_store_id),
}))

export type ObservationRow = typeof corpus_observations.$inferSelect
export type ObservationInsert = typeof corpus_observations.$inferInsert
