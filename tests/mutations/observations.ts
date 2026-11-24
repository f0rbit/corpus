import type { MutationManifest } from "./types.js";

const drizzle = "backend/drizzle-storage.ts";
const client = "observations/client.ts";
const storage = "observations/storage.ts";

export const manifest = {
	cluster: "observations",
	old_tests: [
		"tests/integration/observations-memory.test.ts",
		"tests/integration/observations-file.test.ts",
		"tests/integration/observations-entity.test.ts",
		"tests/integration/observations-version-filter.test.ts",
		"tests/integration/observations-exclude-version.test.ts",
		"tests/integration/observations-transactions.test.ts",
	],
	new_tests: [
		"tests/integration/observations-contract.test.ts",
		"tests/property/observations-equivalence.test.ts",
		"tests/integration/observations-transactions.test.ts",
	],
	mutations: [
		{
			id: "observations/drizzle-delete-by-source-ignores-path",
			file: drizzle,
			find: "conditions.push(eq(corpus_observations.source_path, path));",
			replace: "void path;",
			guards: "drizzle delete_by_source honours the optional path (model: delete_by_source with and without path)",
		},
		{
			id: "observations/drizzle-delete-by-source-returns-zero",
			file: drizzle,
			find: "return count;",
			replace: "return 0;",
			guards: "drizzle delete_by_source reports the affected count",
		},
		{
			id: "observations/drizzle-source-prefix-uses-eq",
			file: drizzle,
			find: "conditions.push(like(corpus_observations.source_version, `${opts.source_prefix}%`));",
			replace: "conditions.push(eq(corpus_observations.source_version, opts.source_prefix));",
			guards: "source_prefix is a prefix match, not equality",
		},
		{
			id: "observations/drizzle-drops-exclude-source-version",
			file: drizzle,
			find: "conditions.push(ne(corpus_observations.source_version, opts.exclude_source_version));",
			replace: "void ne;",
			guards: "exclude_source_version is applied in SQL",
		},
		{
			id: "observations/drizzle-type-array-takes-first",
			file: drizzle,
			find: "conditions.push(inArray(corpus_observations.type, opts.type));",
			replace: 'conditions.push(eq(corpus_observations.type, opts.type[0] ?? ""));',
			guards: "type array filters by membership of every listed type",
		},
		{
			id: "observations/js-type-array-takes-first",
			file: storage,
			find: "return types.includes(r.type);",
			replace: "return types[0] === r.type;",
			guards: "JS filter pipeline: type array membership",
		},
		{
			id: "observations/js-observed-before-inverted",
			file: storage,
			find: '{ key: "observed_before", predicate: (r, before) => r.observed_at !== null && r.observed_at < (before as string) },',
			replace:
				'{ key: "observed_before", predicate: (r, before) => r.observed_at !== null && r.observed_at > (before as string) },',
			guards: "JS filter pipeline: observed_at `before` is a strict upper bound",
		},
		{
			id: "observations/is-stale-ignores-entity",
			file: client,
			find: "const scoped = await metadata.get_latest(pointer.store_id, { entity_key });",
			replace: "const scoped = await metadata.get_latest(pointer.store_id);",
			guards: "is_stale for a keyed pointer compares against the same entity's latest, not the store-wide latest",
		},
		{
			id: "observations/function-version-filter-limits-first",
			file: client,
			find: "const { limit, ...unlimited } = storage_opts;",
			replace: "const limit = storage_opts.limit;\n\tconst unlimited = storage_opts;",
			guards: "function version_filter runs before limit (storage limit dropped for the scan)",
		},
		{
			id: "observations/put-skips-entity-inheritance",
			file: client,
			find: "const entity_key = inherited.value;",
			replace: "const entity_key = opts.entity_key;",
			guards: "put inherits entity_key from the source snapshot",
		},
		{
			id: "observations/layered-delete-by-source-sums-layers",
			file: "backend/layered.ts",
			find: "return bottom ?? ok(0);",
			replace: "void bottom;\n\t\t\treturn ok(results.reduce((n, r) => n + (r.ok ? r.value : 0), 0));",
			guards: "layered delete_by_source reports the bottom layer's count, not the sum across replicated layers",
		},
	],
} satisfies MutationManifest;
