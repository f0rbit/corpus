/**
 * @module ObservationUtils
 * @description Utility functions for working with SnapshotPointers and observations.
 */

import type { SnapshotPointer } from './types.js';
import type { Result, CorpusError } from '../types.js';
import { ok, err } from '../types.js';
import { last, to_nullable } from '../result.js';

/**
 * Creates a SnapshotPointer to a location in a snapshot.
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param store_id - The store identifier
 * @param version - The snapshot version
 * @param path - Optional JSONPath expression to a specific element
 * @param span - Optional character range within text content
 * @returns A SnapshotPointer instance
 * 
 * @example
 * ```ts
 * // Point to entire snapshot
 * const pointer = create_pointer('hansard', 'AZJx4vM')
 * 
 * // Point to specific element
 * const element = create_pointer('hansard', 'AZJx4vM', '$.speeches[0]')
 * 
 * // Point to text range
 * const range = create_pointer('hansard', 'AZJx4vM', '$.speeches[0].text', { start: 100, end: 250 })
 * ```
 */
export function create_pointer(
  store_id: string,
  version: string,
  path?: string,
  span?: { start: number; end: number }
): SnapshotPointer {
  const pointer: SnapshotPointer = { store_id, version }
  if (path !== undefined) pointer.path = path
  if (span !== undefined) pointer.span = span
  return pointer
}

/**
 * Converts a SnapshotPointer to a stable string key for Map storage.
 * 
 * Format: `store_id:version[:path][:start-end]`
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param pointer - The pointer to convert
 * @returns A string key suitable for use as a Map key
 * 
 * @example
 * ```ts
 * const key = pointer_to_key({ store_id: 'hansard', version: 'abc' })
 * // => 'hansard:abc'
 * 
 * const pathKey = pointer_to_key({ store_id: 'hansard', version: 'abc', path: '$.foo' })
 * // => 'hansard:abc:$.foo'
 * 
 * const spanKey = pointer_to_key({ store_id: 'hansard', version: 'abc', span: { start: 0, end: 10 } })
 * // => 'hansard:abc:0-10'
 * ```
 */
export function pointer_to_key(pointer: SnapshotPointer): string {
  let key = `${pointer.store_id}:${pointer.version}`
  if (pointer.path) key += `:${pointer.path}`
  if (pointer.span) key += `:${pointer.span.start}-${pointer.span.end}`
  return key
}

/**
 * Parses a pointer key back to a SnapshotPointer.
 * 
 * Note: This is a best-effort parse - complex paths containing colons may not round-trip perfectly.
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param key - The string key to parse
 * @returns A SnapshotPointer or null if parsing fails
 * 
 * @example
 * ```ts
 * const pointer = key_to_pointer('hansard:abc:$.foo:0-10')
 * // => { store_id: 'hansard', version: 'abc', path: '$.foo', span: { start: 0, end: 10 } }
 * 
 * const simple = key_to_pointer('hansard:abc')
 * // => { store_id: 'hansard', version: 'abc' }
 * 
 * const invalid = key_to_pointer('invalid')
 * // => null
 * ```
 */
export function key_to_pointer(key: string): SnapshotPointer | null {
  const parts = key.split(':')
  if (parts.length < 2) return null

  const [store_id, version, ...rest] = parts
  if (!store_id || !version) return null

  const pointer: SnapshotPointer = { store_id, version }

  if (rest.length === 0) return pointer

  const last_part = to_nullable(last(rest))
  if (!last_part) return pointer
  const span_match = /^(\d+)-(\d+)$/.exec(last_part)

  if (span_match) {
    const [, start_str, end_str] = span_match
    pointer.span = { start: parseInt(start_str!, 10), end: parseInt(end_str!, 10) }
    const path_parts = rest.slice(0, -1)
    if (path_parts.length > 0) pointer.path = path_parts.join(':')
  } else {
    pointer.path = rest.join(':')
  }

  return pointer
}

/**
 * Resolves a JSONPath expression against a value.
 * 
 * Supports simple dot notation with array indices:
 * - `$` or empty string - Returns the root value
 * - `$.foo` - Property access
 * - `$.foo.bar` - Nested property access
 * - `$.foo[0]` - Array index access
 * - `$.foo[0].bar` - Combined access
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param value - The value to resolve against
 * @param path - The JSONPath expression
 * @returns Result containing the resolved value or an error
 * 
 * @example
 * ```ts
 * const data = { speeches: [{ text: 'Hello', speaker: 'Alice' }] }
 * 
 * const result = resolve_path(data, '$.speeches[0].text')
 * if (result.ok) console.log(result.value) // 'Hello'
 * 
 * const root = resolve_path(data, '$')
 * if (root.ok) console.log(root.value) // { speeches: [...] }
 * ```
 */
export function resolve_path<T = unknown>(value: unknown, path: string): Result<T, CorpusError> {
  if (!path || path === '$') return ok(value as T)

  const normalized = path.startsWith('$.')
    ? path.slice(2)
    : path.startsWith('$')
      ? path.slice(1)
      : path

  if (!normalized) return ok(value as T)

  const segments = normalized.split(/\.|\[|\]/).filter(s => s !== '')

  let current: unknown = value
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return err({
        kind: 'not_found',
        store_id: '',
        version: '',
        message: `Path segment '${segment}' not found - parent is null/undefined`
      } as CorpusError)
    }

    if (typeof current !== 'object') {
      return err({
        kind: 'not_found',
        store_id: '',
        version: '',
        message: `Path segment '${segment}' not found - parent is not an object`
      } as CorpusError)
    }

    const index = /^\d+$/.test(segment) ? parseInt(segment, 10) : segment
    current = (current as Record<string | number, unknown>)[index]
  }

  return ok(current as T)
}

/**
 * Applies a span (character range) to a string value.
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param value - The string to slice
 * @param span - The character range to extract
 * @returns Result containing the substring or an error for invalid spans
 * 
 * @example
 * ```ts
 * const result = apply_span('Hello, world!', { start: 0, end: 5 })
 * if (result.ok) console.log(result.value) // 'Hello'
 * 
 * const invalid = apply_span('Hi', { start: 0, end: 10 })
 * if (!invalid.ok) console.log(invalid.error.kind) // 'validation_error'
 * ```
 */
export function apply_span(value: string, span: { start: number; end: number }): Result<string, CorpusError> {
  if (span.start < 0 || span.end > value.length || span.start > span.end) {
    return err({
      kind: 'validation_error',
      cause: new Error(`Invalid span [${span.start}, ${span.end}] for string of length ${value.length}`),
      message: `Invalid span [${span.start}, ${span.end}] for string of length ${value.length}`
    })
  }
  return ok(value.slice(span.start, span.end))
}

/**
 * Generates a unique observation ID.
 * 
 * Format: `obs_{timestamp}_{random}` where timestamp is base36-encoded
 * and random is 8 characters of base36.
 * 
 * @category Utilities
 * @group Observation Utilities
 * @returns A unique observation ID string
 * 
 * @example
 * ```ts
 * const id = generate_observation_id()
 * // => 'obs_lq9x2k_a7b3c2d1'
 * ```
 */
export function generate_observation_id(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `obs_${timestamp}_${random}`
}

/**
 * Checks if two SnapshotPointers reference the same location.
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param a - First pointer
 * @param b - Second pointer
 * @returns True if pointers reference the same location
 * 
 * @example
 * ```ts
 * const p1 = create_pointer('hansard', 'abc', '$.foo')
 * const p2 = create_pointer('hansard', 'abc', '$.foo')
 * const p3 = create_pointer('hansard', 'xyz', '$.foo')
 * 
 * pointers_equal(p1, p2) // true
 * pointers_equal(p1, p3) // false
 * ```
 */
export function pointers_equal(a: SnapshotPointer, b: SnapshotPointer): boolean {
  if (a.store_id !== b.store_id) return false
  if (a.version !== b.version) return false
  if (a.path !== b.path) return false
  if (a.span?.start !== b.span?.start) return false
  if (a.span?.end !== b.span?.end) return false
  return true
}

/**
 * Creates a pointer to the same snapshot without path or span.
 * 
 * @category Utilities
 * @group Pointer Utilities
 * @param pointer - The source pointer
 * @returns A pointer to just the snapshot (store_id + version)
 * 
 * @example
 * ```ts
 * const detailed = create_pointer('hansard', 'abc', '$.speeches[0]', { start: 0, end: 100 })
 * const snapshot = pointer_to_snapshot(detailed)
 * // => { store_id: 'hansard', version: 'abc' }
 * ```
 */
export function pointer_to_snapshot(pointer: SnapshotPointer): SnapshotPointer {
  return { store_id: pointer.store_id, version: pointer.version }
}
