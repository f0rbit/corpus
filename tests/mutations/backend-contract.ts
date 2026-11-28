import type { MutationManifest } from "./types.js";

const contract = "tests/integration/backend-contract.test.ts";
const model = "tests/property/backend-equivalence.test.ts";
const drizzle = "backend/drizzle-storage.ts";
const remote_r2 = "backend/remote-r2.ts";

// old = contract (pre-prune, from the base commit) + model (the remote-r2 unit tests were deleted before 0.10.0); new = pruned contract + model.
// Every mutant targets a path one of the pruned/deleted tests exercised.
export const manifest = {
	cluster: "backend-contract",
	old_tests: [contract, model],
	new_tests: [contract, model],
	mutations: [
		{
			id: "backend-contract/memory-meta-delete-noop",
			file: "backend/memory.ts",
			find: "async delete(store_id, version) {\n\t\t\tmeta_store.delete(make_meta_key(store_id, version));",
			replace: "async delete(store_id, version) {\n\t\t\tvoid make_meta_key(store_id, version);",
			guards: "metadata delete removes the row (pruned: removes stored metadata)",
		},
		{
			id: "backend-contract/file-meta-put-corrupts-field",
			file: "backend/file.ts",
			find: "store_meta.set(meta.version, meta);\n\t\t\t\tawait write_store_meta(meta.store_id, store_meta);",
			replace:
				"store_meta.set(meta.version, { ...meta, size_bytes: meta.size_bytes + 1 });\n\t\t\t\tawait write_store_meta(meta.store_id, store_meta);",
			guards: "metadata put round-trips every field (pruned: preserves all metadata fields)",
		},
		{
			id: "backend-contract/drizzle-drops-parents",
			file: drizzle,
			find: "parents: JSON.stringify(meta.parents),",
			replace: "parents: JSON.stringify([]),",
			guards: "row-to-meta parents mapping (pruned: preserves all metadata fields, get_children)",
		},
		{
			id: "backend-contract/drizzle-list-limit-ignored",
			file: drizzle,
			find: "if (opts?.limit) {\n\t\t\t\tquery = query.limit(opts.limit) as typeof query;",
			replace: "if (opts?.limit && false) {\n\t\t\t\tquery = query.limit(opts.limit) as typeof query;",
			guards: "list limit (pruned: respects limit option)",
		},
		{
			id: "backend-contract/remote-r2-exists-inverted",
			file: remote_r2,
			find: "return file.exists();",
			replace: "return file.exists().then((present) => !present);",
			guards: "data exists (pruned: exists true/false; remote-r2.test exists tests)",
		},
		{
			id: "backend-contract/remote-r2-get-missing-returns-handle",
			file: remote_r2,
			find: "if (!(await file.exists())) return null;",
			replace: "if (false as boolean) return null;",
			guards: "data get of a missing key is null/not_found (pruned: returns not_found for missing data)",
		},
		{
			id: "backend-contract/remote-r2-delete-noop",
			file: remote_r2,
			find: "const result = await try_catch_async(\n\t\t\t\t() => file.delete(),",
			replace: "const result = await try_catch_async(\n\t\t\t\t() => Promise.resolve(),",
			guards: "data delete removes the object (pruned: removes stored data; remote-r2.test delete)",
		},
		{
			id: "backend-contract/cloudflare-r2-exists-inverted",
			file: "backend/cloudflare.ts",
			find: "return head.ok ? head.value !== null : false;",
			replace: "return head.ok ? head.value === null : false;",
			guards: "cloudflare R2 exists adapter (pruned: exists true/false)",
		},
		{
			id: "backend-contract/file-find-by-hash-matches-anything",
			file: "backend/file.ts",
			find: "if (meta.content_hash === content_hash) {",
			replace: "if (meta.content_hash !== undefined) {",
			guards: "find_by_hash compares the hash (pruned: finds by content hash, returns null when not found)",
		},
	],
} satisfies MutationManifest;
