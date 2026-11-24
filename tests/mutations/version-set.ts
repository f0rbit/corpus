import type { MutationManifest } from "./types.js";

const lib = "version-set.ts";
const tests = ["tests/integration/version-set.test.ts"];

export const manifest = {
	cluster: "version-set",
	old_tests: tests,
	new_tests: tests,
	mutations: [
		{
			id: "version-set/data-key-ignores-package",
			file: lib,
			find: 'const pkg = ctx.tags?.find((t) => t.startsWith("pkg:"))?.slice(4) ?? "unknown";',
			replace: 'const pkg = "unknown";',
			guards: "data_key partitions by the package tag",
		},
		{
			id: "version-set/lineage-stops-after-start",
			file: lib,
			find: "cursor = self_parent(meta_result.value)?.version;",
			replace: "cursor = undefined;",
			guards: "lineage walks parents back to the root put",
		},
		{
			id: "version-set/lineage-follows-cross-store-parents",
			file: lib,
			find: "return meta.parents.find((p) => p.store_id === id);",
			replace: "return meta.parents[0];",
			guards: "lineage ignores parents pointing at other stores",
		},
		{
			id: "version-set/promote-drops-merged-tags",
			file: lib,
			find: "tags: merge_pkg_tag(source.data.package, to_tags),",
			replace: "tags: merge_pkg_tag(source.data.package),",
			guards: "promote applies the new tags",
		},
		{
			id: "version-set/version-affinity-default-none",
			file: lib,
			find: 'version_affinity: z.enum(["pinned", "none"]).default("pinned"),',
			replace: 'version_affinity: z.enum(["pinned", "none"]).default("none"),',
			guards: 'asset version_affinity defaults to "pinned"',
		},
		{
			id: "version-set/git-sha-length-loosened",
			file: lib,
			find: "git_sha: z.string().length(40),",
			replace: "git_sha: z.string().min(1),",
			guards: "git_sha must be exactly 40 characters",
		},
		{
			id: "version-set/ref-from-meta-wrong-field",
			file: lib,
			find: "return { package: pkg, version: meta.version, content_hash: meta.content_hash };",
			replace: "return { package: pkg, version: meta.version, content_hash: meta.version };",
			guards: "lineage refs carry the snapshot content_hash",
		},
	],
} satisfies MutationManifest;
