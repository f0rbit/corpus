import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import {
  define_observation_type,
  create_pointer,
  pointer_to_key,
  key_to_pointer,
  resolve_path,
  apply_span,
  generate_observation_id,
  pointers_equal,
  pointer_to_snapshot
} from '../../observations'

describe('define_observation_type', () => {
  it('creates type definition with name and schema', () => {
    const schema = z.object({ text: z.string() })
    const type = define_observation_type('test-type', schema)

    expect(type.name).toBe('test-type')
    expect(type.schema).toBe(schema)
  })

  it('schema validates matching objects', () => {
    const schema = z.object({ count: z.number().min(0) })
    const type = define_observation_type('counter', schema)

    const valid = type.schema.safeParse({ count: 5 })
    expect(valid.success).toBe(true)

    const invalid = type.schema.safeParse({ count: -1 })
    expect(invalid.success).toBe(false)
  })

  it('schema rejects invalid types', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const type = define_observation_type('person', schema)

    const invalid_name = type.schema.safeParse({ name: 123, age: 25 })
    expect(invalid_name.success).toBe(false)

    const missing_field = type.schema.safeParse({ name: 'Alice' })
    expect(missing_field.success).toBe(false)
  })

  it('preserves generic type inference', () => {
    const type = define_observation_type('typed', z.object({
      name: z.string(),
      value: z.number(),
    }))

    const result = type.schema.parse({ name: 'test', value: 42 })
    expect(result.name).toBe('test')
    expect(result.value).toBe(42)
  })

  it('supports complex nested schemas', () => {
    const nested_schema = z.object({
      entity: z.string(),
      entity_type: z.enum(['person', 'organization', 'topic', 'location']),
      context: z.string().optional(),
      mentions: z.array(z.object({
        start: z.number(),
        end: z.number()
      }))
    })
    const type = define_observation_type('entity_mention', nested_schema)

    const valid = type.schema.safeParse({
      entity: 'Climate Change',
      entity_type: 'topic',
      mentions: [{ start: 0, end: 14 }]
    })
    expect(valid.success).toBe(true)

    const invalid_enum = type.schema.safeParse({
      entity: 'Test',
      entity_type: 'invalid_type',
      mentions: []
    })
    expect(invalid_enum.success).toBe(false)
  })

  it('works with optional fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.number().optional()
    })
    const type = define_observation_type('with-optional', schema)

    const without_optional = type.schema.safeParse({ required: 'test' })
    expect(without_optional.success).toBe(true)

    const with_optional = type.schema.safeParse({ required: 'test', optional: 42 })
    expect(with_optional.success).toBe(true)
  })
})

describe('create_pointer', () => {
  it('creates pointer with store_id and version', () => {
    const pointer = create_pointer('my-store', 'v123')

    expect(pointer.store_id).toBe('my-store')
    expect(pointer.version).toBe('v123')
    expect(pointer.path).toBeUndefined()
    expect(pointer.span).toBeUndefined()
  })

  it('creates pointer with optional path', () => {
    const pointer = create_pointer('store', 'v1', '$.items[0].name')

    expect(pointer.path).toBe('$.items[0].name')
    expect(pointer.span).toBeUndefined()
  })

  it('creates pointer with optional span', () => {
    const pointer = create_pointer('store', 'v1', undefined, { start: 10, end: 20 })

    expect(pointer.path).toBeUndefined()
    expect(pointer.span).toEqual({ start: 10, end: 20 })
  })

  it('creates pointer with both path and span', () => {
    const pointer = create_pointer('store', 'v1', '$.text', { start: 0, end: 100 })

    expect(pointer.path).toBe('$.text')
    expect(pointer.span).toEqual({ start: 0, end: 100 })
  })

  it('creates minimal pointer matching expected shape', () => {
    const pointer = create_pointer('hansard', 'abc123')
    expect(pointer).toEqual({ store_id: 'hansard', version: 'abc123' })
  })
})

describe('pointer_to_key', () => {
  it('serializes basic pointer', () => {
    const key = pointer_to_key({ store_id: 'docs', version: 'abc123' })
    expect(key).toBe('docs:abc123')
  })

  it('includes path in key', () => {
    const key = pointer_to_key({ store_id: 'docs', version: 'v1', path: '$.title' })
    expect(key).toBe('docs:v1:$.title')
  })

  it('includes span in key', () => {
    const key = pointer_to_key({ store_id: 'docs', version: 'v1', span: { start: 5, end: 10 } })
    expect(key).toBe('docs:v1:5-10')
  })

  it('includes both path and span', () => {
    const key = pointer_to_key({
      store_id: 'docs',
      version: 'v1',
      path: '$.body',
      span: { start: 0, end: 50 }
    })
    expect(key).toBe('docs:v1:$.body:0-50')
  })

  it('handles nested path correctly', () => {
    const key = pointer_to_key({ store_id: 'hansard', version: 'abc', path: '$.foo.bar' })
    expect(key).toBe('hansard:abc:$.foo.bar')
  })
})

describe('key_to_pointer', () => {
  it('parses basic key', () => {
    const pointer = key_to_pointer('docs:abc123')
    expect(pointer).toEqual({ store_id: 'docs', version: 'abc123' })
  })

  it('returns null for invalid key', () => {
    expect(key_to_pointer('')).toBeNull()
    expect(key_to_pointer('invalid')).toBeNull()
  })

  it('parses key with path', () => {
    const pointer = key_to_pointer('hansard:abc:$.foo.bar')
    expect(pointer).toEqual({ store_id: 'hansard', version: 'abc', path: '$.foo.bar' })
  })

  it('parses key with span', () => {
    const pointer = key_to_pointer('hansard:abc:0-10')
    expect(pointer).toEqual({ store_id: 'hansard', version: 'abc', span: { start: 0, end: 10 } })
  })

  it('parses key with path and span', () => {
    const pointer = key_to_pointer('hansard:abc:$.foo:5-20')
    expect(pointer).toEqual({
      store_id: 'hansard',
      version: 'abc',
      path: '$.foo',
      span: { start: 5, end: 20 }
    })
  })

  it('handles path with colons', () => {
    const pointer = key_to_pointer('hansard:abc:$.data:nested')
    expect(pointer).toEqual({ store_id: 'hansard', version: 'abc', path: '$.data:nested' })
  })

  it('round-trips simple pointers', () => {
    const original = create_pointer('hansard', 'v1', '$.speeches[0]')
    const key = pointer_to_key(original)
    const parsed = key_to_pointer(key)
    expect(parsed).toEqual(original)
  })

  it('round-trips pointers with span', () => {
    const original = create_pointer('hansard', 'v1', '$.text', { start: 10, end: 50 })
    const key = pointer_to_key(original)
    const parsed = key_to_pointer(key)
    expect(parsed).toEqual(original)
  })

  it('round-trips minimal pointers', () => {
    const original = create_pointer('store', 'version123')
    const key = pointer_to_key(original)
    const parsed = key_to_pointer(key)
    expect(parsed).toEqual(original)
  })
})

describe('resolve_path', () => {
  const data = {
    speeches: [
      { text: 'Hello world', speaker: 'Alice' },
      { text: 'Goodbye', speaker: 'Bob' }
    ],
    metadata: {
      date: '2024-01-15',
      nested: { value: 42 }
    }
  }

  it('returns root value for empty path', () => {
    const result = resolve_path({ foo: 'bar' }, '')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ foo: 'bar' })
  })

  it('returns root value for $ path', () => {
    const result = resolve_path({ foo: 'bar' }, '$')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ foo: 'bar' })
  })

  it('resolves simple property access', () => {
    const result = resolve_path({ name: 'test' }, '$.name')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('test')
  })

  it('resolves nested property access', () => {
    const obj = { user: { profile: { name: 'Alice' } } }
    const result = resolve_path(obj, '$.user.profile.name')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('Alice')
  })

  it('resolves array index access', () => {
    const result = resolve_path({ items: ['a', 'b', 'c'] }, '$.items[1]')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('b')
  })

  it('resolves mixed property and array access', () => {
    const obj = { data: { list: [{ id: 1 }, { id: 2 }] } }
    const result = resolve_path(obj, '$.data.list[1].id')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(2)
  })

  it('returns undefined for non-existent property', () => {
    const result = resolve_path({ foo: 'bar' }, '$.missing')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeUndefined()
  })

  it('returns error for path through null', () => {
    const result = resolve_path({ foo: null }, '$.foo.bar')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('not_found')
  })

  it('returns error for path through primitive', () => {
    const result = resolve_path({ foo: 'string' }, '$.foo.bar')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('not_found')
  })

  it('handles path without $ prefix', () => {
    const result = resolve_path(data, 'metadata.date')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('2024-01-15')
  })

  it('resolves with complex nested data', () => {
    const result = resolve_path(data, '$.metadata.nested.value')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(42)
  })

  it('resolves array with property', () => {
    const result = resolve_path(data, '$.speeches[1].text')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('Goodbye')
  })

  it('resolves with type parameter', () => {
    const result = resolve_path<string>(data, '$.speeches[0].text')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const text: string = result.value
      expect(text).toBe('Hello world')
    }
  })

  it('returns error for path through undefined', () => {
    const result = resolve_path({ foo: undefined }, '$.foo.bar')
    expect(result.ok).toBe(false)
  })
})

describe('apply_span', () => {
  it('extracts substring with valid span', () => {
    const result = apply_span('Hello World', { start: 0, end: 5 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('Hello')
  })

  it('extracts middle substring', () => {
    const result = apply_span('Hello World', { start: 6, end: 11 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('World')
  })

  it('extracts full string', () => {
    const result = apply_span('Hi', { start: 0, end: 2 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('Hi')
  })

  it('returns empty for zero-width span', () => {
    const result = apply_span('Hello', { start: 2, end: 2 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('')
  })

  it('returns error for negative start', () => {
    const result = apply_span('test', { start: -1, end: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation_error')
  })

  it('returns error for end beyond length', () => {
    const result = apply_span('test', { start: 0, end: 100 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation_error')
  })

  it('returns error for start > end', () => {
    const result = apply_span('test', { start: 3, end: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation_error')
  })

  it('handles unicode characters (note: slice uses UTF-16 code units)', () => {
    const result = apply_span('🔥🎉🚀', { start: 0, end: 4 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('🔥🎉')
  })

  it('handles empty string with zero-span', () => {
    const result = apply_span('', { start: 0, end: 0 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('')
  })
})

describe('generate_observation_id', () => {
  it('generates unique ids', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generate_observation_id())
    }
    expect(ids.size).toBe(100)
  })

  it('generates ids with obs_ prefix', () => {
    const id = generate_observation_id()
    expect(id.startsWith('obs_')).toBe(true)
  })

  it('has expected format with timestamp and random parts', () => {
    const id = generate_observation_id()
    const parts = id.split('_')
    expect(parts.length).toBe(3)
    expect(parts[0]).toBe('obs')
  })

  it('generates sortable ids by time', () => {
    const id1 = generate_observation_id()
    const id2 = generate_observation_id()
    const ts1 = id1.split('_')[1]
    const ts2 = id2.split('_')[1]
    expect(ts1!.localeCompare(ts2!)).toBeLessThanOrEqual(0)
  })
})

describe('pointers_equal', () => {
  it('returns true for identical pointers', () => {
    const a = { store_id: 'docs', version: 'v1' }
    const b = { store_id: 'docs', version: 'v1' }
    expect(pointers_equal(a, b)).toBe(true)
  })

  it('returns false for different store_id', () => {
    const a = { store_id: 'docs', version: 'v1' }
    const b = { store_id: 'other', version: 'v1' }
    expect(pointers_equal(a, b)).toBe(false)
  })

  it('returns false for different version', () => {
    const a = { store_id: 'docs', version: 'v1' }
    const b = { store_id: 'docs', version: 'v2' }
    expect(pointers_equal(a, b)).toBe(false)
  })

  it('compares paths', () => {
    const a = { store_id: 'docs', version: 'v1', path: '$.foo' }
    const b = { store_id: 'docs', version: 'v1', path: '$.foo' }
    const c = { store_id: 'docs', version: 'v1', path: '$.bar' }

    expect(pointers_equal(a, b)).toBe(true)
    expect(pointers_equal(a, c)).toBe(false)
  })

  it('compares spans', () => {
    const a = { store_id: 'docs', version: 'v1', span: { start: 0, end: 10 } }
    const b = { store_id: 'docs', version: 'v1', span: { start: 0, end: 10 } }
    const c = { store_id: 'docs', version: 'v1', span: { start: 0, end: 20 } }

    expect(pointers_equal(a, b)).toBe(true)
    expect(pointers_equal(a, c)).toBe(false)
  })

  it('distinguishes presence vs absence of path', () => {
    const a = create_pointer('hansard', 'abc', '$.foo')
    const b = create_pointer('hansard', 'abc')
    expect(pointers_equal(a, b)).toBe(false)
  })

  it('distinguishes different span starts', () => {
    const a = { store_id: 'docs', version: 'v1', span: { start: 0, end: 10 } }
    const b = { store_id: 'docs', version: 'v1', span: { start: 5, end: 10 } }
    expect(pointers_equal(a, b)).toBe(false)
  })

  it('handles both undefined spans as equal', () => {
    const a = { store_id: 'docs', version: 'v1' }
    const b = { store_id: 'docs', version: 'v1' }
    expect(pointers_equal(a, b)).toBe(true)
  })
})

describe('pointer_to_snapshot', () => {
  it('strips path and span', () => {
    const pointer = {
      store_id: 'docs',
      version: 'v1',
      path: '$.foo',
      span: { start: 0, end: 10 }
    }
    const snapshot = pointer_to_snapshot(pointer)

    expect(snapshot.store_id).toBe('docs')
    expect(snapshot.version).toBe('v1')
    expect(snapshot.path).toBeUndefined()
    expect(snapshot.span).toBeUndefined()
  })

  it('returns same values for minimal pointer', () => {
    const minimal = create_pointer('hansard', 'abc')
    const snapshot = pointer_to_snapshot(minimal)
    expect(snapshot).toEqual({ store_id: 'hansard', version: 'abc' })
  })

  it('returns new object (not same reference)', () => {
    const original = create_pointer('hansard', 'abc')
    const snapshot = pointer_to_snapshot(original)
    expect(snapshot).not.toBe(original)
  })

  it('preserves store_id and version exactly', () => {
    const detailed = create_pointer('hansard', 'abc', '$.speeches[0]', { start: 0, end: 100 })
    const snapshot = pointer_to_snapshot(detailed)
    expect(snapshot).toEqual({ store_id: 'hansard', version: 'abc' })
  })
})
