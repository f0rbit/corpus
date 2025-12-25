/**
 * @module ObservationsStorage
 * @description Raw storage interface and row conversion utilities for observations.
 */

import type { Result, CorpusError } from '../types'
import { ok } from '../types'
import { create_filter_pipeline } from '../utils'
import type { ObservationRow } from './schema'
import type { Observation, ObservationMeta, SnapshotPointer } from './types'

/**
 * Query options for raw storage operations.
 * Dates are ISO strings at the storage layer.
 */
export type StorageQueryOpts = {
  type?: string | string[]
  source_store_id?: string
  source_version?: string
  source_prefix?: string
  created_after?: string   // ISO string
  created_before?: string  // ISO string
  observed_after?: string  // ISO string  
  observed_before?: string // ISO string
  limit?: number
}

/**
 * Raw storage adapter for observation rows.
 * Backends implement this thin interface; all business logic lives in the client.
 */
export type ObservationsStorage = {
  /** Store a row. Returns the row on success. */
  put_row: (row: ObservationRow) => Promise<Result<ObservationRow, CorpusError>>
  
  /** Get a row by ID. Returns null if not found. */
  get_row: (id: string) => Promise<Result<ObservationRow | null, CorpusError>>
  
  /** Query rows with optional filters. */
  query_rows: (opts?: StorageQueryOpts) => AsyncIterable<ObservationRow>
  
  /** Delete a row by ID. Returns true if deleted, false if not found. */
  delete_row: (id: string) => Promise<Result<boolean, CorpusError>>
  
  /** Delete rows matching source. Returns count deleted. */
  delete_by_source: (store_id: string, version: string, path?: string) => Promise<Result<number, CorpusError>>
}

/**
 * Extract common fields from an observation row (everything except content).
 * Used internally by row_to_observation and row_to_meta.
 */
function row_to_base(row: ObservationRow) {
  return {
    id: row.id,
    type: row.type,
    source: {
      store_id: row.source_store_id,
      version: row.source_version,
      ...(row.source_path && { path: row.source_path }),
      ...(row.source_span_start && row.source_span_end && {
        span: {
          start: parseInt(row.source_span_start, 10),
          end: parseInt(row.source_span_end, 10)
        }
      })
    },
    ...(row.confidence !== null && { confidence: row.confidence }),
    ...(row.observed_at && { observed_at: new Date(row.observed_at) }),
    created_at: new Date(row.created_at),
    ...(row.derived_from && { derived_from: JSON.parse(row.derived_from) })
  }
}

/**
 * Convert a storage row to an Observation (includes content).
 */
export function row_to_observation(row: ObservationRow): Observation {
  return {
    ...row_to_base(row),
    content: JSON.parse(row.content)
  }
}

/**
 * Convert a storage row to ObservationMeta (excludes content).
 */
export function row_to_meta(row: ObservationRow): ObservationMeta {
  return row_to_base(row) as ObservationMeta
}

/**
 * Create an ObservationRow from put options.
 */
export function create_observation_row(
  id: string,
  type_name: string,
  source: SnapshotPointer,
  content: unknown,
  opts: {
    confidence?: number
    observed_at?: Date
    derived_from?: SnapshotPointer[]
  }
): ObservationRow {
  const now = new Date()
  return {
    id,
    type: type_name,
    source_store_id: source.store_id,
    source_version: source.version,
    source_path: source.path ?? null,
    source_span_start: source.span?.start?.toString() ?? null,
    source_span_end: source.span?.end?.toString() ?? null,
    content: JSON.stringify(content),
    confidence: opts.confidence ?? null,
    observed_at: opts.observed_at?.toISOString() ?? null,
    created_at: now.toISOString(),
    derived_from: opts.derived_from ? JSON.stringify(opts.derived_from) : null
  }
}

const observation_filter_pipeline = create_filter_pipeline<ObservationRow, StorageQueryOpts>({
  filters: [
    { 
      key: 'type', 
      predicate: (r, type) => {
        const types = Array.isArray(type) ? type : [type as string]
        return types.includes(r.type)
      }
    },
    { key: 'source_store_id', predicate: (r, id) => r.source_store_id === id },
    { key: 'source_version', predicate: (r, version) => r.source_version === version },
    { key: 'source_prefix', predicate: (r, prefix) => r.source_version.startsWith(prefix as string) },
    { key: 'created_after', predicate: (r, after) => r.created_at > (after as string) },
    { key: 'created_before', predicate: (r, before) => r.created_at < (before as string) },
    { key: 'observed_after', predicate: (r, after) => r.observed_at !== null && r.observed_at > (after as string) },
    { key: 'observed_before', predicate: (r, before) => r.observed_at !== null && r.observed_at < (before as string) }
  ],
  sort: (a, b) => b.created_at.localeCompare(a.created_at)
})

/**
 * Filter and sort observation rows based on query options.
 * Used by in-memory storage implementations (memory backend, file backend).
 */
export function filter_observation_rows(
  rows: ObservationRow[],
  opts: StorageQueryOpts = {}
): ObservationRow[] {
  return observation_filter_pipeline(rows, opts)
}

/**
 * Base CRUD operations for observation storage backends.
 * All backends must implement at minimum these operations.
 */
export type ObservationsCRUDBase = {
  get_all: () => Promise<ObservationRow[]>
  set_all: (rows: ObservationRow[]) => Promise<void>
  get_one: (id: string) => Promise<ObservationRow | null>
  add_one: (row: ObservationRow) => Promise<Result<void, CorpusError>>
  remove_one: (id: string) => Promise<Result<boolean, CorpusError>>
}

/**
 * Optional optimized operations for backends with native query capabilities.
 * When provided, these are used instead of loading all rows into memory.
 */
export type ObservationsCRUDOptimized = {
  query: (opts: StorageQueryOpts) => AsyncIterable<ObservationRow>
  delete_by_source: (store_id: string, version: string, path?: string) => Promise<Result<number, CorpusError>>
}

/**
 * Storage adapter interface for observation backends.
 * Backends provide base CRUD operations and optionally optimized operations.
 */
export type ObservationsAdapter = ObservationsCRUDBase & Partial<ObservationsCRUDOptimized>

/**
 * @deprecated Use ObservationsAdapter instead
 */
export type ObservationsCRUD = {
  get_all: () => Promise<ObservationRow[]>
  set_all: (rows: ObservationRow[]) => Promise<void>
  get_one: (id: string) => Promise<ObservationRow | null>
  add_one: (row: ObservationRow) => Promise<void>
  remove_one: (id: string) => Promise<boolean>
}

/**
 * Create an ObservationsStorage from an adapter.
 * 
 * Backends provide simple CRUD operations and optionally optimized query/delete operations.
 * When optimized operations are not provided, falls back to loading all rows into memory.
 * 
 * @param adapter - Storage adapter with base CRUD and optional optimized operations
 * @returns ObservationsStorage interface for use with create_observations_client
 */
export function create_observations_storage(adapter: ObservationsAdapter | ObservationsCRUD): ObservationsStorage {
  const wrap_add_one = async (row: ObservationRow): Promise<Result<void, CorpusError>> => {
    const result = await (adapter as ObservationsAdapter).add_one(row)
    if (result === undefined || result === null) return ok(undefined)
    if (typeof result === 'object' && 'ok' in result) return result
    return ok(undefined)
  }

  const wrap_remove_one = async (id: string): Promise<Result<boolean, CorpusError>> => {
    const result = await (adapter as ObservationsAdapter).remove_one(id)
    if (typeof result === 'boolean') return ok(result)
    if (typeof result === 'object' && 'ok' in result) return result
    return ok(false)
  }

  return {
    async put_row(row) {
      const result = await wrap_add_one(row)
      if (!result.ok) return result
      return ok(row)
    },

    async get_row(id) {
      const row = await adapter.get_one(id)
      return ok(row)
    },

    async *query_rows(opts: StorageQueryOpts = {}) {
      if ((adapter as ObservationsAdapter).query) {
        yield* (adapter as ObservationsAdapter).query!(opts)
      } else {
        const rows = filter_observation_rows(await adapter.get_all(), opts)
        for (const row of rows) {
          yield row
        }
      }
    },

    async delete_row(id) {
      return wrap_remove_one(id)
    },

    async delete_by_source(store_id, version, path) {
      if ((adapter as ObservationsAdapter).delete_by_source) {
        return (adapter as ObservationsAdapter).delete_by_source!(store_id, version, path)
      }
      
      const rows = await adapter.get_all()
      const toKeep = rows.filter(r => 
        !(r.source_store_id === store_id && 
          r.source_version === version &&
          (path === undefined || r.source_path === path))
      )
      const deleted = rows.length - toKeep.length
      await adapter.set_all(toKeep)
      return ok(deleted)
    }
  }
}
