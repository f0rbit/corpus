import type { MutationManifest } from "./types.js";

const model = "tests/property/backend-equivalence.test.ts";
const drizzle = "backend/drizzle-storage.ts";

export const manifest = {
	cluster: "backend-model",
	old_tests: [model],
	new_tests: [model],
	mutations: [
		{
			id: "backend-model/list-store-id-like-not-eq",
			file: drizzle,
			find: "const conditions = [eq(corpus_snapshots.store_id, store_id)];",
			replace: "const conditions = [like(corpus_snapshots.store_id, store_id)];",
			guards: "list matches store_id exactly (alp/alpha, a_b/axb pools)",
		},
		{
			id: "backend-model/list-drops-tag-filter",
			file: drizzle,
			find: "conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${corpus_snapshots.tags}) WHERE value = ${tag})`);",
			replace: "void tag;",
			guards: "list tag filter",
		},
		{
			id: "backend-model/list-drops-entity-filter",
			file: drizzle,
			find: "conditions.push(eq(corpus_snapshots.entity_key, opts.entity_key));",
			replace: "void opts.entity_key;",
			guards: "list entity_key filter",
		},
		{
			id: "backend-model/get-latest-drops-entity-filter",
			file: drizzle,
			find: "and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.entity_key, opts.entity_key))",
			replace: "eq(corpus_snapshots.store_id, store_id)",
			guards: "get_latest entity scoping",
		},
		{
			id: "backend-model/latest-tie-strict-gt",
			file: "backend/base.ts",
			find: "meta.created_at >= latest.created_at",
			replace: "meta.created_at > latest.created_at",
			guards: "get_latest tie-break: later insertion wins (4-date pool)",
		},
		{
			id: "backend-model/before-boundary-inclusive",
			file: "utils.ts",
			find: "m.created_at < (before as Date)",
			replace: "m.created_at <= (before as Date)",
			guards: "list `before` is exclusive",
		},
		{
			id: "backend-model/limit-ignored",
			file: "utils.ts",
			find: "if (opts.limit) {\n\t\t\tfiltered = filtered.slice(0, opts.limit);",
			replace: "if (opts.limit && false) {\n\t\t\tfiltered = filtered.slice(0, opts.limit);",
			guards: "JS filter pipeline applies limit",
		},
		{
			id: "backend-model/list-stores-reversed",
			file: drizzle,
			find: "rows.value.map((r) => r.store_id).toSorted()",
			replace: "rows.value.map((r) => r.store_id).toSorted().toReversed()",
			guards: "list_stores sorted ascending",
		},
		{
			id: "backend-model/get-children-drops-version",
			file: drizzle,
			find: "AND json_extract(value, '$.version') = ${parent_version}",
			replace: "AND ${parent_version} = ${parent_version}",
			guards: "get_children matches parent version",
		},
		{
			id: "backend-model/wrap-exists-false",
			file: "backend/base.ts",
			find: "exists: storage.exists,",
			replace: "exists: async () => false,",
			guards: "wrap_bytes_storage exists passthrough",
		},
		{
			id: "backend-model/find-by-hash-drops-store",
			file: drizzle,
			find: ".where(and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.content_hash, content_hash)))",
			replace: ".where(eq(corpus_snapshots.content_hash, content_hash))",
			guards: "find_by_hash scoped to store",
		},
	],
} satisfies MutationManifest;
