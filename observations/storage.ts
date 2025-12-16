/**
 * @module ObservationsStorage
 * @description Raw storage interface and row conversion utilities for observations.
 */

import type { Result, CorpusError } from '../types'
import { ok } from '../types'
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

/**
 * Filter and sort observation rows based on query options.
 * Used by in-memory storage implementations (memory backend, file backend).
 */
export function filter_observation_rows(
  rows: ObservationRow[],
  opts: StorageQueryOpts = {}
): ObservationRow[] {
  let filtered = rows

  if (opts.type) {
    const types = Array.isArray(opts.type) ? opts.type : [opts.type]
    filtered = filtered.filter(r => types.includes(r.type))
  }

  if (opts.source_store_id) {
    filtered = filtered.filter(r => r.source_store_id === opts.source_store_id)
  }
  if (opts.source_version) {
    filtered = filtered.filter(r => r.source_version === opts.source_version)
  }
  if (opts.source_prefix) {
    filtered = filtered.filter(r => r.source_version.startsWith(opts.source_prefix!))
  }

  if (opts.created_after) {
    filtered = filtered.filter(r => r.created_at > opts.created_after!)
  }
  if (opts.created_before) {
    filtered = filtered.filter(r => r.created_at < opts.created_before!)
  }
  if (opts.observed_after) {
    filtered = filtered.filter(r => r.observed_at && r.observed_at > opts.observed_after!)
  }
  if (opts.observed_before) {
    filtered = filtered.filter(r => r.observed_at && r.observed_at < opts.observed_before!)
  }

  filtered.sort((a, b) => b.created_at.localeCompare(a.created_at))

  if (opts.limit) {
    filtered = filtered.slice(0, opts.limit)
  }

  return filtered
}

/**
 * Simple CRUD interface for observation storage backends.
 */
export type ObservationsCRUD = {
  get_all: () => Promise<ObservationRow[]>
  set_all: (rows: ObservationRow[]) => Promise<void>
  get_one: (id: string) => Promise<ObservationRow | null>
  add_one: (row: ObservationRow) => Promise<void>
  remove_one: (id: string) => Promise<boolean>
}

/**
 * Create an ObservationsStorage from simple CRUD operations.
 * Used by memory and file backends.
 */
export function create_observations_storage(crud: ObservationsCRUD): ObservationsStorage {
  return {
    async put_row(row) {
      await crud.add_one(row)
      return ok(row)
    },

    async get_row(id) {
      const row = await crud.get_one(id)
      return ok(row)
    },

    async *query_rows(opts: StorageQueryOpts = {}) {
      const rows = filter_observation_rows(await crud.get_all(), opts)
      for (const row of rows) {
        yield row
      }
    },

    async delete_row(id) {
      const deleted = await crud.remove_one(id)
      return ok(deleted)
    },

    async delete_by_source(store_id, version, path) {
      const rows = await crud.get_all()
      const toKeep = rows.filter(r => 
        !(r.source_store_id === store_id && 
          r.source_version === version &&
          (path === undefined || r.source_path === path))
      )
      const deleted = rows.length - toKeep.length
      await crud.set_all(toKeep)
      return ok(deleted)
    }
  }
}
