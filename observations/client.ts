/**
 * @module ObservationsClient
 * @description Centralized business logic for observations, built on storage adapters.
 */

import type { Result, CorpusError, MetadataClient, ObservationsClient } from '../types.js';
import type { Observation, ObservationMeta, ObservationTypeDef, ObservationPutOpts, ObservationQueryOpts, SnapshotPointer, VersionFilter } from './types.js';
import type { ObservationsStorage, StorageQueryOpts } from './storage.js';
import { row_to_observation, row_to_meta, create_observation_row } from './storage.js';
import { generate_observation_id } from './utils.js';
import { ok, err } from '../types.js';

async function apply_version_filter(filter: VersionFilter, store_id: string, version: string): Promise<boolean> {
	if (typeof filter === "function") return filter(store_id, version);
	if (filter instanceof Set) return filter.has(version);
	return filter.includes(version);
}

/**
 * Convert client query opts to storage query opts.
 * Handles Date -> ISO string conversion.
 */
function to_storage_opts(opts: ObservationQueryOpts): StorageQueryOpts {
	return {
		type: opts.type,
		source_store_id: opts.source_store,
		source_version: opts.source_version,
		source_prefix: opts.source_prefix,
		created_after: opts.created_after?.toISOString(),
		created_before: opts.created_before?.toISOString(),
		observed_after: opts.after?.toISOString(),
		observed_before: opts.before?.toISOString(),
		limit: opts.limit,
	};
}

/**
 * Creates an ObservationsClient from a storage adapter.
 * All business logic (validation, staleness, etc.) is centralized here.
 */
export function create_observations_client(storage: ObservationsStorage, metadata: MetadataClient): ObservationsClient {
	async function get_latest_version(store_id: string): Promise<string | null> {
		const result = await metadata.get_latest(store_id);
		return result.ok ? result.value.version : null;
	}

	return {
		async put<T>(type: ObservationTypeDef<T>, opts: ObservationPutOpts<T>): Promise<Result<Observation<T>, CorpusError>> {
			const validation = type.schema.safeParse(opts.content);
			if (!validation.success) {
				return err({
					kind: "validation_error",
					cause: validation.error,
					message: validation.error.message,
				});
			}

			const id = generate_observation_id();
			const row = create_observation_row(id, type.name, opts.source, validation.data, {
				confidence: opts.confidence,
				observed_at: opts.observed_at,
				derived_from: opts.derived_from,
			});

			const result = await storage.put_row(row);
			if (!result.ok) return result;

			const observation: Observation<T> = {
				id,
				type: type.name,
				source: opts.source,
				content: validation.data,
				...(opts.confidence !== undefined && { confidence: opts.confidence }),
				...(opts.observed_at && { observed_at: opts.observed_at }),
				created_at: new Date(row.created_at),
				...(opts.derived_from && { derived_from: opts.derived_from }),
			};

			return ok(observation);
		},

		async get(id: string): Promise<Result<Observation, CorpusError>> {
			const result = await storage.get_row(id);
			if (!result.ok) return result;

			if (!result.value) {
				return err({ kind: "observation_not_found", id });
			}

			return ok(row_to_observation(result.value));
		},

		async *query(opts: ObservationQueryOpts = {}): AsyncIterable<Observation> {
			const storageOpts = to_storage_opts(opts);

			for await (const row of storage.query_rows(storageOpts)) {
				if (opts.version_filter !== undefined) {
					const included = await apply_version_filter(opts.version_filter, row.source_store_id, row.source_version);
					if (!included) continue;
				}
				yield row_to_observation(row);
			}
		},

		async *query_meta(opts: ObservationQueryOpts = {}): AsyncIterable<ObservationMeta> {
			const storageOpts = to_storage_opts(opts);

			for await (const row of storage.query_rows(storageOpts)) {
				if (opts.version_filter !== undefined) {
					const included = await apply_version_filter(opts.version_filter, row.source_store_id, row.source_version);
					if (!included) continue;
				}
				yield row_to_meta(row);
			}
		},

		async delete(id: string): Promise<Result<void, CorpusError>> {
			const result = await storage.delete_row(id);
			if (!result.ok) return result;

			if (!result.value) {
				return err({ kind: "observation_not_found", id });
			}

			return ok(undefined);
		},

		async delete_by_source(source: SnapshotPointer): Promise<Result<number, CorpusError>> {
			return storage.delete_by_source(source.store_id, source.version, source.path);
		},

		async is_stale(pointer: SnapshotPointer): Promise<boolean> {
			const latest = await get_latest_version(pointer.store_id);
			if (!latest) return false;
			return pointer.version !== latest;
		},
	};
}
