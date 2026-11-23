import type { MutationManifest } from "./types.js";

const contract = "tests/integration/backend-contract.test.ts";
const drizzle = "backend/drizzle-storage.ts";

export const manifest = {
	cluster: "guards",
	old_tests: [
		contract,
		"tests/integration/observations-entity.test.ts",
		"tests/unit/cli-args.test.ts",
		"tests/integration/cli-read.test.ts",
		"tests/integration/file-concurrency.test.ts",
		"tests/integration/listing-errors.test.ts",
		"tests/integration/put-if-changed.test.ts",
		"tests/integration/copy.test.ts",
		"tests/unit/testing-walker.test.ts",
		"tests/integration/layered-backend.test.ts",
	],
	new_tests: [
		contract,
		"tests/integration/observations-contract.test.ts",
		"tests/unit/cli-args.test.ts",
		"tests/integration/cli-read.test.ts",
		"tests/integration/file-concurrency.test.ts",
		"tests/integration/listing-errors.test.ts",
		"tests/integration/put-if-changed.test.ts",
		"tests/integration/copy.test.ts",
		"tests/unit/testing-walker.test.ts",
		"tests/integration/layered-backend.test.ts",
		"tests/integration/observations-id.test.ts",
	],
	// Not listed (unkillable): `desc(sql`rowid`)` tie-break removal in drizzle list/get_latest is an equivalent mutant
	// while idx_store_created exists (a reverse index scan already yields ties in rowid-desc order); the selector-key
	// presence guard needs the in-process CLI entry (cli/main.ts) to be exercised without a spawn.
	mutations: [
		{
			id: "guards/list-store-id-like-not-eq",
			file: drizzle,
			find: "const conditions = [eq(corpus_snapshots.store_id, store_id)];",
			replace: "const conditions = [like(corpus_snapshots.store_id, store_id)];",
			guards: "list filters store_id with exact eq(), not a wildcard like()",
		},
		{
			id: "guards/list-drops-tag-filter",
			file: drizzle,
			find: "conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${corpus_snapshots.tags}) WHERE value = ${tag})`);",
			replace: "void tag;",
			guards: "tag filter runs in SQL before LIMIT",
		},
		{
			id: "guards/list-drops-entity-filter",
			file: drizzle,
			find: "conditions.push(eq(corpus_snapshots.entity_key, opts.entity_key));",
			replace: "void opts.entity_key;",
			guards: "entity filter runs in SQL before LIMIT (list)",
		},
		{
			id: "guards/get-latest-drops-entity-filter",
			file: drizzle,
			find: ": and(eq(corpus_snapshots.store_id, store_id), eq(corpus_snapshots.entity_key, opts.entity_key)),",
			replace: ": eq(corpus_snapshots.store_id, store_id),",
			guards: "get_latest is entity-scoped",
		},
		{
			id: "guards/observations-drops-entity-filter",
			file: drizzle,
			find: "conditions.push(eq(corpus_observations.entity_key, opts.entity_key));",
			replace: "void opts.entity_key;",
			guards: "observation entity filter runs in SQL before LIMIT",
		},
		{
			id: "guards/memory-latest-strict-gt",
			file: "backend/base.ts",
			find: "meta.created_at >= latest.created_at",
			replace: "meta.created_at > latest.created_at",
			guards: "get_latest tie-break: later insertion wins on equal created_at",
		},
		{
			id: "guards/args-argv-typo",
			file: "cli/args.ts",
			find: "args: argv,\n\t\toptions: GLOBAL_OPTIONS,",
			replace: "...{ argv },\n\t\toptions: GLOBAL_OPTIONS,",
			guards: "parseArgs config key is `args`, not `argv`",
		},
		{
			id: "guards/args-drops-command-option-tokens",
			file: "cli/args.ts",
			find: 'if (token.kind === "option" && !GLOBAL_OPTION_NAMES.has(token.name)) {',
			replace: 'if (token.kind === "option" && !GLOBAL_OPTION_NAMES.has(token.name) && false) {',
			guards: "token reconstruction re-emits command-specific options",
		},
		{
			id: "guards/lineage-no-cycle-guard",
			file: "cli/commands/lineage.ts",
			find: "if (path.has(key)) {",
			replace: "if (path.has(key) && false) {",
			guards: "lineage renders a (cycle) leaf instead of recursing",
		},
		{
			id: "guards/stores-json-falls-through",
			file: "cli/commands/stores.ts",
			find: "\t\t\t});\n\t\t\treturn ok(undefined);\n\t\t}\n\n\t\tif (ctx.args.counts) {",
			replace: "\t\t\t});\n\t\t}\n\n\t\tif (ctx.args.counts) {",
			guards: "--json emits exactly one document (early return after output.json)",
		},
		{
			id: "guards/file-aliasing-check-off",
			file: "backend/file.ts",
			find: "const owner = find_collision(data_key, claimed_names);",
			replace: "const owner = undefined as string | undefined;",
			guards: "data-key aliasing guard rejects colliding sanitised file names",
		},
		{
			id: "guards/listing-ignores-tracker-errors",
			file: "listing.ts",
			find: "const failure = tracker?.errors.slice(seen)[0];",
			replace: "const failure = undefined as CorpusError | undefined;",
			guards: "bad token is not an empty database: tracked errors fail collect_listing",
		},
		{
			id: "guards/if-changed-compares-by-hash",
			file: "corpus.ts",
			find: "const latest = await backend.metadata.get_latest(id, entity_opts(opts.entity_key));",
			replace:
				'const found = await backend.metadata.find_by_hash(id, content_hash);\n\t\t\tconst latest: Result<SnapshotMeta, CorpusError> = found\n\t\t\t\t? ok(found)\n\t\t\t\t: err({ kind: "not_found", store_id: id, version: "latest" });',
			guards: "if_changed compares against the latest snapshot only, never history (revert must write)",
		},
		{
			id: "guards/copy-metadata-before-data",
			file: "copy.ts",
			find: "return pipe(transfer_data(meta.data_key, meta.size_bytes))\n\t\t.flat_map(() => dest.metadata.put(meta))",
			replace:
				"return pipe(dest.metadata.put(meta))\n\t\t.flat_map(() => transfer_data(meta.data_key, meta.size_bytes))",
			guards: "copy writes data before metadata at dest",
		},
		{
			id: "guards/walker-no-self-skip",
			file: "testing/vending/walker.ts",
			find: "if (manifest.name === SELF_PACKAGE_NAME) return null;",
			replace: "if (manifest.name === SELF_PACKAGE_NAME && false) return null;",
			guards: "dev-checkout guard: walker skips the corpus package itself",
		},
		{
			id: "guards/layered-observations-shared-id",
			file: "backend/layered.ts",
			find: "const with_id = { ...opts, id };",
			replace: "const with_id = opts;",
			guards: "layered put fans one shared id out to every write layer",
		},
		{
			id: "guards/observation-id-collision-memory",
			file: "backend/memory.ts",
			find: "if (observation_store.has(row.id)) return err(observation_id_collision(row.id));",
			replace: "void observation_id_collision;",
			guards: "memory add_one rejects a repeated observation id instead of overwriting",
		},
		{
			id: "guards/observation-id-collision-file",
			file: "backend/file.ts",
			find: "if (rows.some((r) => r.id === row.id)) return err(observation_id_collision(row.id));",
			replace: "void observation_id_collision;",
			guards: "file add_one rejects a repeated observation id instead of duplicating the row",
		},
	],
} satisfies MutationManifest;
