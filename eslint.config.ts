import { define_lint_config } from "@f0rbit/lint";

// Overrides mirror the documented intentional exceptions in AGENTS.md —
// config-scoped here, never inline eslint-disable comments in source.
export default define_lint_config({
	naming: "snake_case",
	package_name: "@f0rbit/corpus",
	tsconfig_root_dir: import.meta.dirname,
	overrides: [
		{
			// Semaphore is the one sanctioned class — it owns mutable internal state.
			// parallel_map's try/finally is the semaphore-release pattern; the Result
			// combinators can't express `finally`.
			files: ["concurrency.ts"],
			rules: {
				"functional/no-classes": "off",
				"functional/no-this-expressions": "off",
				"functional/no-try-statements": "off",
			},
		},
		{
			// apply_batch's transactional commit is structural try/catch: the staging
			// try's catch is compensation (nuke the staging dir), and the rename loop's
			// catch carries the ops_completed/ops_failed counters for partial_commit.
			// Everything else in the file goes through try_catch_async.
			files: ["backend/file.ts"],
			rules: { "functional/no-try-statements": "off" },
		},
		{
			// create_corpus().build() throws by design: config-time programmer-error guard
			files: ["corpus.ts"],
			rules: { "functional/no-throw-statements": "off" },
		},
		{
			// unwrap()/or_throw()/null_on()/fallback_on() throw by contract — including
			// non-Error error values (E is unconstrained); try_catch/try_catch_async ARE
			// the sanctioned try/catch → Result boundary
			files: ["result.ts"],
			rules: {
				"functional/no-throw-statements": "off",
				"functional/no-try-statements": "off",
				"@typescript-eslint/only-throw-error": "off",
			},
		},
		{
			// fetch_result's default parse_body is a documented ergonomic default over
			// an unconstrained generic T — it cannot Zod-validate a type it knows nothing
			// about. Callers wanting validation supply their own parse_body doing
			// schema.parse(response.json()) or similar.
			files: ["result.ts"],
			rules: { "f0rbit/require-schema-at-boundary": "off" },
		},
		{
			// sqlite-proxy callback contract expects throw on failure; the shared drizzle
			// layer wraps this in try_catch_async and converts to Result. This is the
			// sanctioned fetch-edge boundary (documented in AGENTS.md) -- the try/catch
			// around fetch()/response.json() is what maps native throws into the
			// callback's own thrown Error, so both rules are scoped off together here.
			files: ["backend/remote-d1.ts"],
			rules: { "functional/no-throw-statements": "off", "functional/no-try-statements": "off" },
		},
		{
			// arbitrary-construction errors throw with actionable messages (documented design)
			files: ["testing/**"],
			rules: { "functional/no-throw-statements": "off" },
		},
		{
			// The walker narrows Zod v3 schemas via instanceof, but Zod's own generics are
			// any-parameterised (ZodObject<any, ...>, _def.shape() returns any) — every
			// recursive walk() call trips the rule. The single boundary cast is documented
			// in AGENTS.md; the internals are untypeable without forking Zod's types.
			files: ["testing/arb.ts"],
			rules: { "@typescript-eslint/no-unsafe-argument": "off" },
		},
		{
			// CoverageError is an Error subclass so fast-check reporting and consumer
			// instanceof checks work — a legitimate class, like Semaphore.
			files: ["testing/cover.ts"],
			rules: {
				"functional/no-classes": "off",
				"functional/no-this-expressions": "off",
			},
		},
		{
			// `{}` is the intersection-identity for the builder's accumulated stores map
			// (CorpusBuilder<{}> → Stores & { [id]: Store<T> }); Record<string, never>
			// would collapse every accumulated store type to never. Public API shape.
			files: ["types.ts", "corpus.ts"],
			rules: { "@typescript-eslint/no-empty-object-type": "off" },
		},
		{
			// ObservationsCRUD is corpus's own deprecated legacy adapter type, retained
			// (re-export + union member) until the next major; its removal is the
			// documented migration, not this lint pass.
			files: ["observations/index.ts", "observations/storage.ts"],
			rules: { "@typescript-eslint/no-deprecated": "off" },
		},
		{
			// row.derived_from is a DB TEXT column corpus itself writes and reads back —
			// a round-trip of corpus's own data, not external input crossing a trust
			// boundary. See AGENTS.md's require-schema-at-boundary rollout note.
			files: ["observations/storage.ts"],
			rules: { "f0rbit/require-schema-at-boundary": "off" },
		},
		{
			// testing/registry.ts + testing/vending/** degrade duplicate-registration and
			// auto-load discovery failures to console.warn by design (documented in
			// AGENTS.md's testing-substrate section) — the message points callers at
			// testing.load_from(...). Not a redesign target for this lint pass.
			files: ["testing/registry.ts", "testing/vending/**"],
			rules: { "no-console": "off" },
		},
		{
			// fake_console_warn is the in-memory fake that intercepts console.warn for
			// the testing-substrate warn-UX assertions above — it necessarily reads and
			// reassigns the real global to record/restore it.
			files: ["tests/fakes/console.ts"],
			rules: { "no-console": "off" },
		},
		{
			// cli/output.ts is the single output funnel for all CLI printing (the one
			// place console.log and process.stdout.write appear in the CLI tree) — all
			// other cli/ files route through Output methods defined here. This exception
			// is scoped tightly to this one file; CLI command implementations in
			// cli/commands/*.ts retain the no-console ban.
			files: ["cli/output.ts"],
			rules: { "no-console": "off" },
		},
		{
			// test code: fakes and assertions may throw/try/use classes; Result discipline
			// off. only-throw-error: tests deliberately throw strings/objects to exercise
			// format_error/try_catch mapping. await-thenable + no-confusing-void-expression:
			// bun's expect().rejects matcher typings return void, but the await IS required
			// at runtime — dropping it would let tests pass before the assertion settles.
			files: ["tests/**"],
			rules: {
				"functional/no-classes": "off",
				"functional/no-this-expressions": "off",
				"functional/no-throw-statements": "off",
				"functional/no-try-statements": "off",
				"f0rbit/must-use-result": "off",
				"@typescript-eslint/only-throw-error": "off",
				"@typescript-eslint/await-thenable": "off",
				"@typescript-eslint/no-confusing-void-expression": "off",
			},
		},
		{
			// the enum exists to exercise arb()'s z.nativeEnum walker branch
			files: ["tests/unit/testing-arb.test.ts"],
			rules: { "no-restricted-syntax": "off" },
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
