/**
 * @module ObservationsClient
 * @description Centralized business logic for observations, built on storage adapters.
 */

import { z } from "zod/v4";
import type { Result, CorpusError, CorpusEvent, MetadataClient, ObservationsClient } from "../types.js";
import type {
	Observation,
	ObservationMeta,
	ObservationTypeDef,
	ObservationPutOpts,
	ObservationQueryOpts,
	SnapshotPointer,
} from "./types.js";
import type { ObservationRow } from "./schema.js";
import type { ObservationsStorage, StorageQueryOpts } from "./storage.js";
import { row_to_observation, row_to_meta, create_observation_row } from "./storage.js";
import { generate_observation_id } from "./utils.js";
import { as_error } from "../utils.js";
import { ok, err } from "../types.js";

const query_keys = {
	entity_key: true,
	type: true,
	source_store: true,
	source_version: true,
	exclude_source_version: true,
	source_prefix: true,
	after: true,
	before: true,
	created_after: true,
	created_before: true,
	limit: true,
	cursor: true,
	version_filter: true,
} as const satisfies Record<keyof ObservationQueryOpts, true>;

const query_keys_schema = z.strictObject(
	Object.fromEntries(Object.keys(query_keys).map((key) => [key, z.unknown().optional()])),
);

type Emit = (event: CorpusEvent) => void;

function check_query_keys(opts: ObservationQueryOpts, emit: Emit): boolean {
	const parsed = query_keys_schema.safeParse(opts);
	if (parsed.success) return true;
	emit({
		type: "error",
		error: { kind: "validation_error", cause: as_error(parsed.error), message: parsed.error.message },
	});
	return false;
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
		exclude_source_version: opts.exclude_source_version,
		source_prefix: opts.source_prefix,
		created_after: opts.created_after?.toISOString(),
		created_before: opts.created_before?.toISOString(),
		observed_after: opts.after?.toISOString(),
		observed_before: opts.before?.toISOString(),
		entity_key: opts.entity_key,
		limit: opts.limit,
	};
}

/**
 * Rows matching opts including version_filter. Set/array filters run in storage (before LIMIT);
 * function filters scan all candidate rows and stop after `limit` matches.
 */
async function* filtered_rows(storage: ObservationsStorage, opts: ObservationQueryOpts): AsyncIterable<ObservationRow> {
	const filter = opts.version_filter;
	const storage_opts = to_storage_opts(opts);
	if (filter === undefined) {
		yield* storage.query_rows(storage_opts);
		return;
	}
	if (typeof filter !== "function") {
		const versions = [...filter];
		if (versions.length === 0) return;
		yield* storage.query_rows({ ...storage_opts, source_version_in: versions });
		return;
	}
	const { limit, ...unlimited } = storage_opts;
	let matched = 0;
	for await (const row of storage.query_rows(unlimited)) {
		if (!(await filter(row.source_store_id, row.source_version))) continue;
		yield row;
		matched += 1;
		if (limit && matched >= limit) return;
	}
}

/**
 * Creates an ObservationsClient from a storage adapter.
 * All business logic (validation, staleness, etc.) is centralized here.
 */
export function create_observations_client(
	storage: ObservationsStorage,
	metadata: MetadataClient,
	emit: Emit = () => undefined,
): ObservationsClient {
	async function get_latest_version(store_id: string): Promise<string | null> {
		const result = await metadata.get_latest(store_id);
		return result.ok ? result.value.version : null;
	}

	async function source_entity_key(source: SnapshotPointer): Promise<Result<string | undefined, CorpusError>> {
		const meta = await metadata.get(source.store_id, source.version);
		if (meta.ok) return ok(meta.value.entity_key);
		return meta.error.kind === "not_found" ? ok(undefined) : meta;
	}

	return {
		async put<T>(
			type: ObservationTypeDef<T>,
			opts: ObservationPutOpts<T>,
		): Promise<Result<Observation<T>, CorpusError>> {
			const validation = type.schema.safeParse(opts.content);
			if (!validation.success) {
				return err({
					kind: "validation_error",
					cause: as_error(validation.error),
					message: validation.error.message,
				});
			}

			const inherited = opts.entity_key === undefined ? await source_entity_key(opts.source) : ok(opts.entity_key);
			if (!inherited.ok) return inherited;
			const entity_key = inherited.value;

			const id = generate_observation_id();
			const row = create_observation_row(id, type.name, opts.source, validation.data, {
				confidence: opts.confidence,
				observed_at: opts.observed_at,
				derived_from: opts.derived_from,
				entity_key,
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
				...(entity_key !== undefined && { entity_key }),
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
			if (!check_query_keys(opts, emit)) return;
			for await (const row of filtered_rows(storage, opts)) {
				yield row_to_observation(row);
			}
		},

		async *query_meta(opts: ObservationQueryOpts = {}): AsyncIterable<ObservationMeta> {
			if (!check_query_keys(opts, emit)) return;
			for await (const row of filtered_rows(storage, opts)) {
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
			const source = await metadata.get(pointer.store_id, pointer.version);
			const entity_key = source.ok ? source.value.entity_key : undefined;
			if (entity_key !== undefined) {
				const scoped = await metadata.get_latest(pointer.store_id, { entity_key });
				return scoped.ok && pointer.version !== scoped.value.version;
			}
			const latest = await get_latest_version(pointer.store_id);
			if (!latest) return false;
			return pointer.version !== latest;
		},
	};
}
