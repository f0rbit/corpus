import { describe, it, expect, beforeEach } from 'bun:test'
import { z } from 'zod'
import { create_memory_backend } from '../backend/memory'
import { define_observation_type, create_pointer } from '../observations'
import type { ObservationsClient } from '../types'

const SentimentType = define_observation_type('sentiment', z.object({
  subject: z.string(),
  score: z.number().min(-1).max(1),
  keywords: z.array(z.string()),
}))

const EntityType = define_observation_type('entity', z.object({
  name: z.string(),
  type: z.enum(['person', 'org', 'location']),
  mentions: z.number(),
}))

const SimpleType = define_observation_type('simple', z.object({
  value: z.string(),
}))

describe('observations integration - memory backend', () => {
  let backend: ReturnType<typeof create_memory_backend>
  let observations: ObservationsClient

  beforeEach(() => {
    backend = create_memory_backend()
    observations = backend.observations!
  })

  describe('basic CRUD', () => {
    it('puts and gets an observation', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        content: { subject: 'test', score: 0.8, keywords: ['good'] },
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return

      const obs = result.value
      expect(obs.type).toBe('sentiment')
      expect(obs.content.subject).toBe('test')
      expect(obs.content.score).toBe(0.8)
      expect(obs.source.store_id).toBe('docs')
      expect(obs.source.version).toBe('v1')
      expect(obs.id).toMatch(/^obs_/)

      const getResult = await observations.get(obs.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.id).toBe(obs.id)
      }
    })

    it('returns observation_not_found for missing id', async () => {
      const result = await observations.get('nonexistent')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('observation_not_found')
      }
    })

    it('deletes an observation', async () => {
      const putResult = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
      })
      expect(putResult.ok).toBe(true)
      if (!putResult.ok) return

      const deleteResult = await observations.delete(putResult.value.id)
      expect(deleteResult.ok).toBe(true)

      const getResult = await observations.get(putResult.value.id)
      expect(getResult.ok).toBe(false)
    })

    it('delete returns not_found for missing id', async () => {
      const result = await observations.delete('nonexistent')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('observation_not_found')
      }
    })

    it('delete_by_source removes matching observations', async () => {
      const source = create_pointer('docs', 'v1')
      await observations.put(SimpleType, { source, content: { value: 'a' } })
      await observations.put(SimpleType, { source, content: { value: 'b' } })
      await observations.put(SimpleType, { 
        source: create_pointer('docs', 'v2'), 
        content: { value: 'c' } 
      })

      const deleteResult = await observations.delete_by_source(source)
      expect(deleteResult.ok).toBe(true)
      if (deleteResult.ok) {
        expect(deleteResult.value).toBe(2)
      }

      let count = 0
      for await (const _ of observations.query({ include_stale: true })) {
        count++
      }
      expect(count).toBe(1)
    })

    it('delete_by_source returns 0 for no matches', async () => {
      const result = await observations.delete_by_source(create_pointer('nonexistent', 'v1'))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toBe(0)
      }
    })

    it('delete_by_source respects path filter', async () => {
      const base = create_pointer('docs', 'v1')
      const withPath = create_pointer('docs', 'v1', '$.specific')
      
      await observations.put(SimpleType, { source: base, content: { value: 'a' } })
      await observations.put(SimpleType, { source: withPath, content: { value: 'b' } })

      const deleteResult = await observations.delete_by_source(withPath)
      expect(deleteResult.ok).toBe(true)
      if (deleteResult.ok) {
        expect(deleteResult.value).toBe(1)
      }

      let count = 0
      for await (const _ of observations.query({ include_stale: true })) {
        count++
      }
      expect(count).toBe(1)
    })
  })

  describe('type validation', () => {
    it('validates content against schema on put', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        content: { subject: 'test', score: 0.5, keywords: ['word'] },
      })
      expect(result.ok).toBe(true)
    })

    it('rejects invalid content - missing field', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        // @ts-expect-error - testing invalid content
        content: { subject: 'test' },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation_error')
      }
    })

    it('rejects invalid content - wrong type', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        // @ts-expect-error - testing invalid content
        content: { subject: 123, score: 'bad', keywords: 'not-array' },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation_error')
      }
    })

    it('rejects invalid content - out of range', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        content: { subject: 'test', score: 5.0, keywords: [] },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation_error')
      }
    })

    it('rejects invalid content - score below minimum', async () => {
      const result = await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        content: { subject: 'test', score: -2.0, keywords: [] },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation_error')
      }
    })

    it('rejects invalid enum value', async () => {
      const result = await observations.put(EntityType, {
        source: create_pointer('docs', 'v1'),
        content: { name: 'Test', type: 'invalid' as any, mentions: 1 },
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe('validation_error')
      }
    })

    it('accepts valid enum value', async () => {
      const result = await observations.put(EntityType, {
        source: create_pointer('docs', 'v1'),
        content: { name: 'Test Corp', type: 'org', mentions: 5 },
      })
      expect(result.ok).toBe(true)
    })
  })

  describe('query filtering', () => {
    beforeEach(async () => {
      await observations.put(SentimentType, {
        source: create_pointer('docs', 'v1'),
        content: { subject: 'topic1', score: 0.8, keywords: ['good'] },
        observed_at: new Date('2024-01-15'),
      })
      await observations.put(SentimentType, {
        source: create_pointer('docs', 'v2'),
        content: { subject: 'topic2', score: -0.5, keywords: ['bad'] },
        observed_at: new Date('2024-02-15'),
      })
      await observations.put(EntityType, {
        source: create_pointer('articles', 'a1'),
        content: { name: 'Acme Corp', type: 'org', mentions: 5 },
        observed_at: new Date('2024-01-20'),
      })
    })

    it('filters by type', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ type: 'sentiment', include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('filters by multiple types', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ type: ['sentiment', 'entity'], include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(3)
    })

    it('filters by source_store', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ source_store: 'docs', include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('filters by source_version', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ source_version: 'v1', include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(1)
    })

    it('filters by source_prefix', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ source_prefix: 'v', include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('filters by observed_at range - after only', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ 
        after: new Date('2024-01-20'),
        include_stale: true,
      })) {
        results.push(obs)
      }
      expect(results.length).toBe(1)
    })

    it('filters by observed_at range - before only', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ 
        before: new Date('2024-01-20'),
        include_stale: true,
      })) {
        results.push(obs)
      }
      expect(results.length).toBe(1)
    })

    it('filters by observed_at range - both after and before', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ 
        after: new Date('2024-01-10'),
        before: new Date('2024-01-31'),
        include_stale: true,
      })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('respects limit', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ limit: 1, include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(1)
    })

    it('respects limit of 2', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ limit: 2, include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('query_meta excludes content', async () => {
      for await (const meta of observations.query_meta({ type: 'sentiment', include_stale: true })) {
        expect(meta.id).toBeDefined()
        expect(meta.type).toBe('sentiment')
        expect((meta as any).content).toBeUndefined()
      }
    })

    it('query_meta respects filters', async () => {
      const results: unknown[] = []
      for await (const meta of observations.query_meta({ source_store: 'articles', include_stale: true })) {
        results.push(meta)
      }
      expect(results.length).toBe(1)
    })

    it('combines multiple filters', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ 
        type: 'sentiment',
        source_store: 'docs',
        include_stale: true,
      })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('returns empty for non-matching filters', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ 
        type: 'nonexistent',
        include_stale: true,
      })) {
        results.push(obs)
      }
      expect(results.length).toBe(0)
    })
  })

  describe('optional fields', () => {
    it('stores and retrieves confidence', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
        confidence: 0.95,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.confidence).toBe(0.95)
      }
    })

    it('stores and retrieves observed_at', async () => {
      const observedAt = new Date('2024-06-15T10:30:00Z')
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
        observed_at: observedAt,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.observed_at?.toISOString()).toBe(observedAt.toISOString())
      }
    })

    it('stores and retrieves derived_from', async () => {
      const derivedFrom = [
        create_pointer('models', 'gpt4'),
        create_pointer('prompts', 'sentiment-v2'),
      ]
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
        derived_from: derivedFrom,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.derived_from).toEqual(derivedFrom)
      }
    })

    it('stores source with path', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1', '$.paragraphs[0]'),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.source.path).toBe('$.paragraphs[0]')
      }
    })

    it('stores source with span', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1', undefined, { start: 100, end: 200 }),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.source.span).toEqual({ start: 100, end: 200 })
      }
    })

    it('stores source with path and span together', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1', '$.text', { start: 50, end: 150 }),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.source.path).toBe('$.text')
        expect(getResult.value.source.span).toEqual({ start: 50, end: 150 })
      }
    })

    it('omits undefined optional fields', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.confidence).toBeUndefined()
        expect(getResult.value.observed_at).toBeUndefined()
        expect(getResult.value.derived_from).toBeUndefined()
        expect(getResult.value.source.path).toBeUndefined()
        expect(getResult.value.source.span).toBeUndefined()
      }
    })
  })

  describe('staleness detection', () => {
    it('is_stale returns false when no snapshots exist', async () => {
      const pointer = create_pointer('docs', 'v1')
      const stale = await observations.is_stale(pointer)
      expect(stale).toBe(false)
    })

    it('is_stale returns false when pointing to latest version', async () => {
      await backend.metadata.put({
        store_id: 'docs',
        version: 'v1',
        parents: [],
        created_at: new Date(),
        content_hash: 'hash1',
        content_type: 'application/json',
        size_bytes: 100,
        data_key: 'docs/hash1',
      })

      const pointer = create_pointer('docs', 'v1')
      const stale = await observations.is_stale(pointer)
      expect(stale).toBe(false)
    })

    it('is_stale returns true when newer version exists', async () => {
      await backend.metadata.put({
        store_id: 'docs',
        version: 'v1',
        parents: [],
        created_at: new Date('2024-01-01'),
        content_hash: 'hash1',
        content_type: 'application/json',
        size_bytes: 100,
        data_key: 'docs/hash1',
      })

      await backend.metadata.put({
        store_id: 'docs',
        version: 'v2',
        parents: [],
        created_at: new Date('2024-01-02'),
        content_hash: 'hash2',
        content_type: 'application/json',
        size_bytes: 100,
        data_key: 'docs/hash2',
      })

      const pointer = create_pointer('docs', 'v1')
      const stale = await observations.is_stale(pointer)
      expect(stale).toBe(true)
    })
  })

  describe('staleness filtering in queries', () => {
    beforeEach(async () => {
      await backend.metadata.put({
        store_id: 'docs',
        version: 'v2',
        parents: [],
        created_at: new Date(),
        content_hash: 'hash2',
        content_type: 'application/json',
        size_bytes: 100,
        data_key: 'docs/hash2',
      })

      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'old' },
      })
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v2'),
        content: { value: 'current' },
      })
    })

    it('query excludes stale by default', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({})) {
        results.push(obs)
      }
      expect(results.length).toBe(1)
    })

    it('query includes stale when requested', async () => {
      const results: unknown[] = []
      for await (const obs of observations.query({ include_stale: true })) {
        results.push(obs)
      }
      expect(results.length).toBe(2)
    })

    it('query_meta excludes stale by default', async () => {
      const results: unknown[] = []
      for await (const meta of observations.query_meta({})) {
        results.push(meta)
      }
      expect(results.length).toBe(1)
    })

    it('query_meta includes stale when requested', async () => {
      const results: unknown[] = []
      for await (const meta of observations.query_meta({ include_stale: true })) {
        results.push(meta)
      }
      expect(results.length).toBe(2)
    })
  })

  describe('timestamps', () => {
    it('sets created_at automatically', async () => {
      const before = new Date()
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
      })
      const after = new Date()

      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.created_at).toBeInstanceOf(Date)
      expect(result.value.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(result.value.created_at.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('preserves created_at on retrieval', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.created_at.toISOString()).toBe(result.value.created_at.toISOString())
      }
    })

    it('created_at differs from observed_at', async () => {
      const observedAt = new Date('2024-01-01')
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
        observed_at: observedAt,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value.created_at.getTime()).not.toBe(observedAt.getTime())
      expect(result.value.observed_at?.toISOString()).toBe(observedAt.toISOString())
    })
  })

  describe('query ordering', () => {
    it('returns observations in created_at descending order', async () => {
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'first' },
      })
      await new Promise(r => setTimeout(r, 5))
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v2'),
        content: { value: 'second' },
      })
      await new Promise(r => setTimeout(r, 5))
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v3'),
        content: { value: 'third' },
      })

      const results: { value: string }[] = []
      for await (const obs of observations.query({ include_stale: true })) {
        results.push(obs.content as { value: string })
      }

      expect(results.length).toBe(3)
      expect(results[0]?.value).toBe('third')
      expect(results[1]?.value).toBe('second')
      expect(results[2]?.value).toBe('first')
    })
  })

  describe('observation id format', () => {
    it('generates unique ids', async () => {
      const ids = new Set<string>()
      
      for (let i = 0; i < 10; i++) {
        const result = await observations.put(SimpleType, {
          source: create_pointer('docs', `v${i}`),
          content: { value: `test${i}` },
        })
        expect(result.ok).toBe(true)
        if (result.ok) {
          ids.add(result.value.id)
        }
      }
      
      expect(ids.size).toBe(10)
    })

    it('ids start with obs_ prefix', async () => {
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'test' },
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.id.startsWith('obs_')).toBe(true)
      }
    })
  })

  describe('created_at filtering', () => {
    beforeEach(async () => {
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content: { value: 'old' },
      })
      
      await new Promise(r => setTimeout(r, 50))
      
      await observations.put(SimpleType, {
        source: create_pointer('docs', 'v2'),
        content: { value: 'new' },
      })
    })

    it('filters by created_after', async () => {
      const all: unknown[] = []
      for await (const obs of observations.query({ include_stale: true })) {
        all.push(obs)
      }
      expect(all.length).toBe(2)
      
      const cutoff = new Date(Date.now() - 25)
      const filtered: unknown[] = []
      for await (const obs of observations.query({ created_after: cutoff, include_stale: true })) {
        filtered.push(obs)
      }
      expect(filtered.length).toBe(1)
    })

    it('filters by created_before', async () => {
      const cutoff = new Date(Date.now() - 25)
      const filtered: unknown[] = []
      for await (const obs of observations.query({ created_before: cutoff, include_stale: true })) {
        filtered.push(obs)
      }
      expect(filtered.length).toBe(1)
    })
  })

  describe('content retrieval', () => {
    it('preserves complex nested content', async () => {
      const ComplexType = define_observation_type('complex', z.object({
        nested: z.object({
          array: z.array(z.object({
            key: z.string(),
            values: z.array(z.number()),
          })),
          optional: z.string().optional(),
        }),
      }))

      const content = {
        nested: {
          array: [
            { key: 'a', values: [1, 2, 3] },
            { key: 'b', values: [4, 5] },
          ],
          optional: 'present',
        },
      }

      const result = await observations.put(ComplexType, {
        source: create_pointer('docs', 'v1'),
        content,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.content).toEqual(content)
      }
    })

    it('handles special characters in content', async () => {
      const content = { value: 'test with "quotes" and \\backslash and unicode: 日本語' }
      
      const result = await observations.put(SimpleType, {
        source: create_pointer('docs', 'v1'),
        content,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const getResult = await observations.get(result.value.id)
      expect(getResult.ok).toBe(true)
      if (getResult.ok) {
        expect(getResult.value.content).toEqual(content)
      }
    })
  })
})
