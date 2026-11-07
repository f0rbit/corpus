/**
 * @module ObservationTypes
 * @description Type definitions for the observations feature.
 */

import type { SchemaLike } from "../types.js";

/**
 * Universal address to versioned content within a corpus store.
 *
 * A SnapshotPointer identifies a specific location within a versioned snapshot:
 * - `store_id` + `version` - Required: which snapshot
 * - `path` - Optional: JSONPath expression to a specific element
 * - `span` - Optional: character range within text content
 *
 * @category Types
 * @group Observation Types
 *
 * @example
 * ```ts
 * // Point to entire snapshot
 * const pointer: SnapshotPointer = {
 *   store_id: 'hansard',
 *   version: 'AZJx4vM'
 * }
 *
 * // Point to specific speech within a transcript
 * const speechPointer: SnapshotPointer = {
 *   store_id: 'hansard',
 *   version: 'AZJx4vM',
 *   path: '$.content[0].speeches[2]'
 * }
 *
 * // Point to text range within content
 * const rangePointer: SnapshotPointer = {
 *   store_id: 'hansard',
 *   version: 'AZJx4vM',
 *   path: '$.content[0].speeches[2].text',
 *   span: { start: 100, end: 250 }
 * }
 * ```
 */
export type SnapshotPointer = {
	store_id: string;
	version: string;
	path?: string;
	span?: {
		start: number;
		end: number;
	};
};

/**
 * Definition for a typed observation schema.
 *
 * Created by `define_observation_type()` and passed to `observations.put()`.
 * The schema validates observation content and provides type inference.
 *
 * @category Types
 * @group Observation Types
 */
export type ObservationTypeDef<T> = {
	readonly name: string;
	readonly schema: SchemaLike<T>;
};

/**
 * A stored observation record linking structured facts to versioned content.
 *
 * Observations are typed facts extracted from or computed about content:
 * - `source` - Points to the content this observation is about
 * - `content` - The typed observation data (validated by schema)
 * - `confidence` - Optional confidence score (0.0 to 1.0)
 * - `observed_at` - When the observation was made (vs when stored)
 * - `derived_from` - Optional provenance chain for computed observations
 *
 * @category Types
 * @group Observation Types
 *
 * @example
 * ```ts
 * const observation: Observation<EntityMention> = {
 *   id: 'obs_abc123',
 *   type: 'entity_mention',
 *   source: { store_id: 'hansard', version: 'AZJx4vM', path: '$.speeches[0]' },
 *   content: { entity: 'Climate Change', entity_type: 'topic' },
 *   confidence: 0.95,
 *   observed_at: new Date('2024-01-15'),
 *   created_at: new Date(),
 *   derived_from: [{ store_id: 'hansard', version: 'AZJx4vM' }]
 * }
 * ```
 */
export type Observation<T = unknown> = {
	id: string;
	type: string;
	source: SnapshotPointer;
	content: T;
	confidence?: number;
	observed_at?: Date;
	created_at: Date;
	derived_from?: SnapshotPointer[];
	/** Entity the observation is about. Inherited from the source snapshot unless set explicitly on put. */
	entity_key?: string;
};

/**
 * Observation metadata without content payload.
 *
 * Used for efficient listing operations where only metadata is needed.
 *
 * @category Types
 * @group Observation Types
 */
export type ObservationMeta = Omit<Observation<never>, "content">;

/**
 * Options for creating a new observation.
 *
 * @category Types
 * @group Observation Types
 */
export type ObservationPutOpts<T> = {
	source: SnapshotPointer;
	content: T;
	confidence?: number;
	observed_at?: Date;
	derived_from?: SnapshotPointer[];
	/**
	 * Entity the observation is about. When omitted, inherited from the source
	 * snapshot's `entity_key`; stored unkeyed if the source is missing or unkeyed.
	 */
	entity_key?: string;
};

/**
 * Filter for version-based observation filtering.
 * - Set<string> or string[]: Include if version is in the collection
 * - Function: Called with (store_id, version), return true to include
 *
 * @category Types
 * @group Observation Types
 *
 * @example
 * ```ts
 * // Filter to specific versions
 * const filter: VersionFilter = new Set(['v1', 'v2', 'v3'])
 *
 * // Or use an array
 * const filter: VersionFilter = ['v1', 'v2', 'v3']
 *
 * // Or use a function for dynamic filtering
 * const filter: VersionFilter = async (store_id, version) => {
 *   const published = await db.query.published_reports.findFirst({
 *     where: eq(published_reports.version, version)
 *   });
 *   return published !== null;
 * };
 * ```
 */
export type VersionFilter =
	| Set<string>
	| string[]
	| ((store_id: string, version: string) => boolean | Promise<boolean>);

/**
 * Query options for filtering observations.
 *
 * @category Types
 * @group Observation Types
 *
 * @example
 * ```ts
 * // Find recent entity mentions from a specific store
 * const opts: ObservationQueryOpts = {
 *   type: 'entity_mention',
 *   source_store: 'hansard',
 *   after: new Date('2024-01-01'),
 *   limit: 100
 * }
 *
 * // Filter to only published versions
 * const versionOpts: ObservationQueryOpts = {
 *   source_store: 'hansard',
 *   version_filter: new Set(['v1', 'v2'])
 * }
 *
 * // Newest observation from any version other than the one about to be written
 * const previous: ObservationQueryOpts = {
 *   type: 'entity_mention',
 *   source_store: 'hansard',
 *   exclude_source_version: 'v3',
 *   limit: 1
 * }
 *
 * // Newest price observations for one entity
 * const for_entity: ObservationQueryOpts = {
 *   type: 'price',
 *   entity_key: 'https://example.com/pricing',
 *   limit: 10
 * }
 * ```
 */
export type ObservationQueryOpts = {
	/** Exact match on `entity_key`. Unkeyed observations never match. */
	entity_key?: string;
	type?: string | string[];
	source_store?: string;
	source_version?: string;
	/**
	 * Drop observations whose `source_version` equals this value.
	 * Combines (AND) with `source_store` / `source_version`. Results are newest-first
	 * (`created_at` desc, ties broken by later insertion first), so the newest
	 * observation from a previous version is
	 * `query({ type, source_store, exclude_source_version: v, limit: 1 })`.
	 */
	exclude_source_version?: string;
	source_prefix?: string;
	after?: Date;
	before?: Date;
	created_after?: Date;
	created_before?: Date;
	limit?: number;
	cursor?: string;
	/**
	 * Filter observations by version.
	 * When provided, only observations whose source version passes the filter are included.
	 *
	 * - Set<string> or string[]: Include if version is in the collection
	 * - Function: Called with (store_id, version), return true to include
	 *
	 * Set/array filters run in storage, before `limit`. Function filters scan all
	 * candidate rows (the storage limit is dropped) and stop after `limit` matches.
	 */
	version_filter?: VersionFilter;
};

/**
 * Utility type to extract the content type from an ObservationTypeDef.
 *
 * @category Types
 * @group Observation Types
 *
 * @example
 * ```ts
 * const entity_mention = define_observation_type('entity_mention', EntityMentionSchema)
 *
 * type EntityMention = InferObservationContent<typeof entity_mention>
 * // => { entity: string; entity_type: 'person' | 'organization' | ... }
 * ```
 */
export type InferObservationContent<T> = T extends ObservationTypeDef<infer C> ? C : never;

/**
 * Defines a typed observation schema.
 *
 * Creates an ObservationTypeDef that provides:
 * - Runtime validation via Zod schema
 * - Compile-time type inference for content
 * - Named type for querying and filtering
 *
 * @category Core
 * @group Observation Helpers
 * @param name - Unique identifier for this observation type
 * @param schema - Zod schema for validating observation content
 * @returns An ObservationTypeDef to pass to `observations.put()`
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 *
 * const EntityMentionSchema = z.object({
 *   entity: z.string(),
 *   entity_type: z.enum(['person', 'organization', 'topic', 'location']),
 *   context: z.string().optional()
 * })
 *
 * const entity_mention = define_observation_type('entity_mention', EntityMentionSchema)
 *
 * // Type-safe usage
 * await corpus.observations.put(entity_mention, {
 *   source: { store_id: 'hansard', version: 'abc123' },
 *   content: { entity: 'Parliament', entity_type: 'organization' }
 * })
 * ```
 */
export function define_observation_type<T>(name: string, schema: SchemaLike<T>): ObservationTypeDef<T> {
	return { name, schema };
}
