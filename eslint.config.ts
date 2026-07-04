import { define_lint_config } from "@f0rbit/lint";

// Overrides mirror the documented intentional exceptions in AGENTS.md —
// config-scoped here, never inline eslint-disable comments in source.
export default define_lint_config({
	naming: "snake_case",
	package_name: "@f0rbit/corpus",
	tsconfig_root_dir: import.meta.dirname,
	overrides: [
		{
			// Semaphore is the one sanctioned class — it owns mutable internal state
			files: ["concurrency.ts"],
			rules: {
				"functional/no-classes": "off",
				"functional/no-this-expressions": "off",
			},
		},
		{
			// create_corpus().build() throws by design: config-time programmer-error guard
			files: ["corpus.ts"],
			rules: { "functional/no-throw-statements": "off" },
		},
		{
			// unwrap()/or_throw() throw by contract; try_catch/try_catch_async ARE the
			// sanctioned try/catch → Result boundary
			files: ["result.ts"],
			rules: {
				"functional/no-throw-statements": "off",
				"functional/no-try-statements": "off",
			},
		},
		{
			// arbitrary-construction errors throw with actionable messages (documented design)
			files: ["testing/**"],
			rules: { "functional/no-throw-statements": "off" },
		},
		{
			// test code: fakes and assertions may throw/try/use classes; Result discipline off
			files: ["tests/**"],
			rules: {
				"functional/no-classes": "off",
				"functional/no-this-expressions": "off",
				"functional/no-throw-statements": "off",
				"functional/no-try-statements": "off",
				"f0rbit/must-use-result": "off",
			},
		},
		{
			// pre-convention public API names — renames are breaking:
			// sst.ts exports createCorpusInfra (SST consumers), version-set.ts exports
			// VersionSetManifestSchema (imported by devpad pipelines) and carries the
			// `_`-prefixed compile-time manifest-shape assertion pair; testing/registry.ts
			// and testing/vending/auto-load.ts export `__`-prefixed test-only escape
			// hatches (documented convention in AGENTS.md). The naming rule can't allow
			// these selectively without duplicating the org selector table.
			files: ["sst.ts", "version-set.ts", "testing/registry.ts", "testing/vending/auto-load.ts"],
			rules: { "@typescript-eslint/naming-convention": "off" },
		},
	],
});
