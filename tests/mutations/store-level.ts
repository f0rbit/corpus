import type { MutationManifest } from "./types.js";

const layered = "backend/layered.ts";
const corpus = "corpus.ts";

export const manifest = {
	cluster: "store-level",
	old_tests: ["tests/integration/memory-backend.test.ts", "tests/integration/layered-backend.test.ts"],
	new_tests: ["tests/integration/memory-backend.test.ts", "tests/integration/layered-backend.test.ts"],
	// The brief's `corpus.ts` meta_list mutation targets the wrong file: the event is emitted by backend/base.ts.
	mutations: [
		{
			id: "store-level/layered-list-dedupe-keeps-last",
			file: layered,
			find: "if (seen.has(meta.version)) continue;\n\t\t\t\t\tseen.add(meta.version);\n\t\t\t\t\tall.push(meta);",
			replace:
				"const dup = all.findIndex((m) => m.version === meta.version);\n\t\t\t\t\tif (dup >= 0) all.splice(dup, 1);\n\t\t\t\t\tseen.add(meta.version);\n\t\t\t\t\tall.push(meta);",
			guards: "layered list: first read layer wins a duplicate version",
		},
		{
			id: "store-level/layered-list-no-dedupe",
			file: layered,
			find: "if (seen.has(meta.version)) continue;\n\t\t\t\t\tseen.add(meta.version);\n\t\t\t\t\tall.push(meta);",
			replace: "seen.add(meta.version);\n\t\t\t\t\tall.push(meta);",
			guards: "layered list: duplicate versions across layers are merged to one",
		},
		{
			id: "store-level/layered-list-ascending-sort",
			file: layered,
			find: "all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());",
			replace: "all.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());",
			guards: "layered list: newest created_at first",
		},
		{
			id: "store-level/layered-list-limit-before-merge",
			file: layered,
			find: "const limit = opts?.limit ?? Infinity;\n\t\t\tfor (const meta of all.slice(0, limit)) {",
			replace: "for (const meta of all) {",
			guards: "layered list: limit is applied to the merged result, not only per layer",
		},
		{
			id: "store-level/get-meta-skips-metadata",
			file: corpus,
			find: "return backend.metadata.get(id, version);\n\t\t},\n\n\t\tlist(opts) {",
			replace: 'return err({ kind: "not_found", store_id: id, version });\n\t\t},\n\n\t\tlist(opts) {',
			guards: "store.get_meta reads metadata from the backend",
		},
		{
			id: "store-level/put-ignores-find-by-hash",
			file: corpus,
			find: "const existing = await backend.metadata.find_by_hash(id, content_hash);\n\t\tconst deduplicated = existing !== null;",
			replace: "const existing = null as SnapshotMeta | null;\n\t\tconst deduplicated = existing !== null;",
			guards: "put reuses the data_key of identical content",
		},
		{
			id: "store-level/list-emits-no-meta-list",
			file: "backend/base.ts",
			find: 'emit({ type: "meta_list", store_id, count });',
			replace: "void count;",
			guards: "listing emits a meta_list event with the count",
		},
		{
			id: "store-level/put-drops-parents",
			file: corpus,
			find: "store_id: id,\n\t\t\tversion,\n\t\t\tparents: opts?.parents ?? [],",
			replace: "store_id: id,\n\t\t\tversion,\n\t\t\tparents: [],",
			guards: "store.put persists parents on the stored meta",
		},
	],
} satisfies MutationManifest;
