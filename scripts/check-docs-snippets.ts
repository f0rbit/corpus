import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { try_catch_async } from "../result.js";
import { err, ok, type Result } from "../types.js";
import { run } from "./lib/worktree.js";

const repo_root = resolve(import.meta.dirname, "..");
const docs_dir = join(repo_root, "docs/src/content/docs");
const register_template = join(repo_root, "docs/templates/testing/register.ts");
const register_name = "docs-templates-register.ts";
const tsc_timeout_ms = 2 * 60_000;

// corpus subpath specifiers before the bare name — a bare `@f0rbit/corpus`
// rewrite must not clobber them. Targets are the repo SOURCE entries, not dist/.
const specifier_map: readonly (readonly [string, string])[] = [
	["@f0rbit/corpus/testing", "testing/index.ts"],
	["@f0rbit/corpus/file", "file.ts"],
	["@f0rbit/corpus/cloudflare", "cloudflare.ts"],
	["@f0rbit/corpus/remote", "remote.ts"],
	["@f0rbit/corpus/types", "types.ts"],
	["@f0rbit/corpus/schema", "schema.ts"],
	["@f0rbit/corpus", "index.ts"],
];

const rewrite_specifiers = (code: string): string =>
	specifier_map.reduce(
		(acc, [name, file]) =>
			acc
				.split(`"${name}"`)
				.join(`"${join(repo_root, file)}"`)
				.split(`'${name}'`)
				.join(`"${join(repo_root, file)}"`),
		code,
	);

type Snippet = { readonly page: string; readonly line: number; readonly code: string };

const fence_open = /^\s*(`{3,})[ \t]*(.*)$/;
const fence_close = /^\s*`{3,}\s*$/;

type OpenFence = { readonly marker: string; readonly meta: string; readonly start: number; readonly body: string[] };

const snippet_meta = (meta: string): { readonly lang: string; readonly skip: boolean } => {
	const lang = meta.trim().split(/\s+/)[0] ?? "";
	return { lang, skip: /\bnocheck\b/.test(meta) };
};

const extract_snippets = (page: string, text: string): readonly Snippet[] => {
	const snippets: Snippet[] = [];
	let open: OpenFence | undefined;
	text.split("\n").forEach((raw, i) => {
		if (open !== undefined) {
			if (fence_close.test(raw) && raw.replace(/^\s*/, "").length >= open.marker.length) {
				const { lang, skip } = snippet_meta(open.meta);
				if ((lang === "ts" || lang === "typescript") && !skip) {
					snippets.push({ page, line: open.start, code: open.body.join("\n") });
				}
				open = undefined;
			} else {
				open.body.push(raw);
			}
			return;
		}
		const m = fence_open.exec(raw);
		if (m === null) return;
		open = { marker: m[1] ?? "", meta: m[2] ?? "", start: i + 1, body: [] };
	});
	return snippets;
};

const count_nocheck = (text: string): number =>
	text.split("\n").filter((l) => /^\s*`{3,}[ \t]*(ts|typescript)\b.*\bnocheck\b/.test(l)).length;

const collect_pages = async (): Promise<Result<string[], string>> =>
	try_catch_async(
		async () => (await Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: docs_dir, onlyFiles: true }))).toSorted(),
		(e) => (e instanceof Error ? e.message : String(e)),
	);

const gather = async (): Promise<
	Result<{ readonly by_file: Map<string, Snippet>; readonly nocheck: number }, string>
> => {
	const pages = await collect_pages();
	if (!pages.ok) return pages;
	const by_file = new Map<string, Snippet>();
	let nocheck = 0;
	for (const entry of pages.value) {
		const page = join(docs_dir, entry);
		const text = await try_catch_async(
			() => Bun.file(page).text(),
			(e) => (e instanceof Error ? e.message : String(e)),
		);
		if (!text.ok) return err(`cannot read ${page}: ${text.error}`);
		nocheck += count_nocheck(text.value);
		for (const snippet of extract_snippets(entry, text.value)) {
			const name = `${entry.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}-${String(by_file.size)}.ts`;
			by_file.set(name, snippet);
		}
	}
	return ok({ by_file, nocheck });
};

const write_workspace = async (dir: string, by_file: Map<string, Snippet>): Promise<Result<void, string>> =>
	try_catch_async(
		async () => {
			await symlink(join(repo_root, "node_modules"), join(dir, "node_modules"));
			for (const [name, snippet] of by_file) {
				await writeFile(join(dir, name), `${rewrite_specifiers(snippet.code)}\nexport {};\n`);
			}
			const template_source = await Bun.file(register_template).text();
			await writeFile(join(dir, register_name), `${rewrite_specifiers(template_source)}\n`);
			// Ambient globals for tutorial-context names that continuation-style
			// snippets assume from surrounding prose or earlier snippets. Globals
			// (not per-file preludes) so a snippet declaring its own `corpus` simply
			// shadows them. Corpus-context names stay fully typed; consumer-side
			// names are `any` — corpus API member access is still checked.
			const idx = join(repo_root, "index.ts");
			const values = [
				"create_corpus",
				"create_store",
				"copy",
				"with_error_tracking",
				"collect_listing",
				"define_config",
				"create_memory_backend",
				"create_cloudflare_backend",
				"create_layered_backend",
				"json_codec",
				"text_codec",
				"binary_codec",
				"compose",
				"compute_hash",
				"generate_version",
				"gzip_codec",
				"encrypt_codec",
				"version_set_store",
				"VersionSetManifestSchema",
				"pipeline_template_store",
				"corpus_snapshots",
				"corpus_observations",
				"ok",
				"err",
				"define_store",
				"match",
				"unwrap_or",
				"unwrap",
				"unwrap_err",
				"try_catch",
				"try_catch_async",
				"fetch_result",
				"pipe",
				"to_nullable",
				"to_fallback",
				"null_on",
				"fallback_on",
				"format_error",
				"at",
				"first",
				"last",
				"merge_deep",
				"Semaphore",
				"parallel_map",
				"createCorpusInfra",
				"row_to_observation",
				"row_to_meta",
				"create_observation_row",
				"filter_observation_rows",
				"create_observations_storage",
				"create_observations_client",
				"create_pointer",
				"pointer_to_key",
				"key_to_pointer",
				"pointers_equal",
				"pointer_to_snapshot",
				"generate_observation_id",
				"observation_id_schema",
				"define_observation_type",
				"resolve_path",
				"apply_span",
			];
			const types_zero = [
				"CorpusError",
				"SnapshotMeta",
				"DataHandle",
				"MetadataClient",
				"DataClient",
				"ListOpts",
				"LatestOpts",
				"Backend",
				"BatchOp",
				"BytesCodec",
				"PutOpts",
				"PutResult",
				"CorpusEvent",
				"EventHandler",
				"ObservationsClient",
				"TransactionHandle",
				"VersionSetManifest",
				"VersionSetRef",
				"VersionSetStore",
				"VersionSetStoreOptions",
				"PipelineTemplateStoreOptions",
				"CorpusSnapshotRow",
				"CorpusSnapshotInsert",
				"FetchError",
				"CopyOpts",
				"CopyProgressEvent",
				"CopySummary",
				"ErrorTracker",
				"CorpusCliConfig",
				"MemoryBackendOptions",
				"CloudflareBackendConfig",
				"LayeredBackendOptions",
				"SnapshotPointer",
				"ParentRef",
				"ContentType",
				"StreamableValue",
				"DefineStoreOpts",
				"ObservationMeta",
				"ObservationQueryOpts",
				"VersionFilter",
				"ObservationsStorage",
				"StorageQueryOpts",
				"ObservationsCRUD",
				"ObservationsAdapter",
				"ObservationRow",
				"ObservationInsert",
			];
			const types_one = [
				"Snapshot",
				"SnapshotHandle",
				"Codec",
				"Parser",
				"ParseResult",
				"SchemaLike",
				"Store",
				"TransactionResult",
				"CorpusBuilder",
				"CorpusBuilderWithBackend",
				"Corpus",
				"PipelineTemplateStore",
				"ObservationTypeDef",
				"Observation",
				"ObservationPutOpts",
				"InferObservationContent",
				"DeepPartial",
				"DataKeyContext",
			];
			const idx_query = `import("${idx}")`;
			const anys = [
				"corrupt_bytes",
				"corrupt_bytes",
				"build_index",
				"source_to_id",
				"encode",
				"decode",
				"create_custom_backend",
				"userId",
				"invalidData",
				"testArticle",
				"docVersion",
				"sentiment",
				"observation",
				"old_version",
				"updated_data",
				"final",
				"evt",
				"raw_text",
				"entity_mention",
				"hash",
				"adapter",
				"metadata_client",
				"config",
				"primary",
				"replica",
				"memoryBackend",
				"fileBackend",
				"newBackend",
				"oldBackend",
				"colors",
				"events",
				"defaultEvent",
				"options",
				"contacts",
				"items",
				"users",
				"user",
				"token",
				"db",
				"metrics",
				"input",
				"data",
				"filename",
				"path",
				"id",
				"manifest",
				"put",
				"SentimentObservation",
				"PriceObservation",
				"EntityExtractionObservation",
				"DisambiguationObservation",
				"FinalAnnotationObservation",
				"PageSchema",
				"ArticleSchema",
				"DocumentSchema",
				"DataSchema",
				"PostSchema",
				"UserSchema",
				"OrderIdSchema",
				"ItemSchema",
				"ArraySchema",
				"MyType",
				"USER_ID_BRAND",
				"MY_BRAND",
				"email_arb",
				"MemoryCounter",
				"FileBackedCounter",
				"env",
				"sst",
				"d1",
				"r2",
				"version",
				"pointer",
				"article",
				"payload",
				"version_sets",
				"templates",
				"page",
				"obs",
				"observations",
				"item",
				"new_version",
				"cache",
				"storage",
				"transcript",
				"logs",
				"images",
				"ConfigSchema",
				"CartSchema",
				"SessionSchema",
				"CacheSchema",
				"SourceSchema",
				"DerivedSchema",
				"EventSchema",
				"SecretSchema",
				"EntitySchema",
				"MySchema",
				"and",
				"eq",
				"published_reports",
				"createUsBackend",
				"createEuBackend",
				"createApBackend",
				"meta_insert_sql",
				"meta_insert_params",
				"meta_delete_sql",
				"data_insert_sql",
				"obs_insert_sql",
				"obs_insert_params",
				"obs_delete_sql",
				"my_bytes_storage",
				"emit",
				"Pool",
				"cleanup",
				"$config",
				"ai",
				"url",
				"init",
				"fn",
				"on_error",
				"s",
				"key",
				"precondition",
				"operation_on_model",
				"operation_on_sut",
				"arb",
				"entity_key",
			];
			const result_fns = [
				"fetchUser",
				"fetchUsers",
				"createUser",
				"fetchProfile",
				"fetchPermissions",
				"getConfig",
				"getCount",
				"count_items",
				"fetch_page",
			];
			const plain_anys = ["processData", "analyzeSentiment", "formatError", "respond", "selectedIndex"];
			const prelude = `
declare const corpus: Omit<${idx_query}.Corpus, "observations"> & { observations: ${idx_query}.ObservationsClient };
declare const store: ${idx_query}.Store<any>;
declare const backend: ${idx_query}.Backend;
${values.map((n) => `declare const ${n}: typeof ${idx_query}["${n}"];`).join("\n")}
declare const testing: typeof import("${join(repo_root, "testing/index.ts")}");
type Result<T = any, E = ${idx_query}.CorpusError> = ${idx_query}.Result<T, E>;
type Pipe<T = any, E = any> = ${idx_query}.Pipe<T, E>;
type StoreDefinition<Id extends string = string, T = any> = ${idx_query}.StoreDefinition<Id, T>;
${types_one.map((n) => `type ${n}<T = any> = ${idx_query}.${n}<T>;`).join("\n")}
${types_zero.map((n) => `type ${n} = ${idx_query}.${n};`).join("\n")}
${anys.map((n) => `declare const ${n}: any;`).join("\n")}
${result_fns.map((n) => `declare const ${n}: (...args: any[]) => ${idx_query}.Result<any, any>;`).join("\n")}
${plain_anys.map((n) => `declare const ${n}: any;`).join("\n")}
declare const extract_facts: (...args: any[]) => any[];
declare const riskyAsyncOperation: (...args: any[]) => Promise<any>;
declare const urls: string[];
declare const z: typeof import("zod").z;
declare namespace z {
	export type infer<T> = import("zod").z.infer<T>;
}
declare function test(name: string, fn: () => unknown): void;
declare function it(name: string, fn: () => unknown): void;
declare function describe(name: string, fn: () => unknown): void;
declare function beforeEach(fn: () => unknown): void;
declare function afterEach(fn: () => unknown): void;
declare const expect: (actual: unknown) => any;
type D1Database = any;
type R2Bucket = any;
type Pool = any;
type Env = any;
type User = any;
type Post = any;
type Counter = any;
type CounterError = any;
`;
			await writeFile(join(dir, "prelude.d.ts"), prelude);
			const tsconfig = {
				extends: join(repo_root, "tsconfig.json"),
				compilerOptions: {
					noUnusedLocals: false,
					noUnusedParameters: false,
					noUncheckedIndexedAccess: false,
				},
				files: [...by_file.keys()].map((n) => join(dir, n)).concat(join(dir, register_name), join(dir, "prelude.d.ts")),
			};
			await writeFile(join(dir, "tsconfig.json"), `${JSON.stringify(tsconfig, null, "\t")}\n`);
		},
		(e) => (e instanceof Error ? e.message : String(e)),
	);

type Diagnostic = { readonly file: string; readonly line: number; readonly message: string };
const diagnostic = /^(.+?)\((\d+),\d+\): error (TS\d+): (.+)$/;

const run_tsc = async (dir: string): Promise<Result<readonly Diagnostic[], string>> => {
	const out = await run(
		[join(repo_root, "node_modules/.bin/tsc"), "--noEmit", "--pretty", "false", "-p", join(dir, "tsconfig.json")],
		{ cwd: repo_root, timeout_ms: tsc_timeout_ms },
	);
	if (out.code === 127) return err(`tsc failed to start: ${out.stderr.trim()}`);
	return ok(
		out.stdout
			.split("\n")
			.map((l) => diagnostic.exec(l.trim()))
			.filter((m): m is RegExpExecArray => m !== null)
			.map((m) => {
				const kind = m[3] ?? "TS0000";
				const message = m[4] ?? "";
				return { file: m[1] ?? "", line: Number(m[2]), message: `${kind}: ${message}` };
			}),
	);
};

const out = (text: string): void => {
	process.stdout.write(`${text}\n`);
};

const main = async (): Promise<number> => {
	const gathered = await gather();
	if (!gathered.ok) {
		process.stderr.write(`docs-snippets: ${gathered.error}\n`);
		return 2;
	}
	const { by_file, nocheck } = gathered.value;
	const dir = await try_catch_async(
		() => mkdtemp(join(tmpdir(), "corpus-docs-snippets-")),
		(e) => (e instanceof Error ? e.message : String(e)),
	);
	if (!dir.ok) {
		process.stderr.write(`docs-snippets: ${dir.error}\n`);
		return 2;
	}
	try {
		const written = await write_workspace(dir.value, by_file);
		if (!written.ok) {
			process.stderr.write(`docs-snippets: ${written.error}\n`);
			return 2;
		}
		const result = await run_tsc(dir.value);
		if (!result.ok) {
			process.stderr.write(`docs-snippets: ${result.error}\n`);
			return 2;
		}
		const is_snippet = (file: string): boolean => {
			const base = file.split("/").pop() ?? "";
			return by_file.has(base) || base === register_name;
		};
		const failures = result.value.filter((d) => is_snippet(d.file));
		for (const d of failures) {
			const base = d.file.split("/").pop() ?? "";
			if (base === register_name) {
				out(`docs/templates/testing/register.ts:${String(d.line)}: ${d.message}`);
				continue;
			}
			const snippet = by_file.get(base);
			if (snippet === undefined) continue;
			out(`docs/src/content/docs/${snippet.page}:${String(snippet.line + d.line - 1)}: ${d.message}`);
		}
		for (const stray of result.value.filter((d) => !is_snippet(d.file))) {
			out(`UNEXPECTED ${stray.file}:${String(stray.line)}: ${stray.message}`);
		}
		const clean = result.value.length === 0;
		out(
			clean
				? `docs-snippets: ${String(by_file.size)} snippet file(s) typechecked${nocheck > 0 ? `, ${String(nocheck)} nocheck skipped` : ""} — clean`
				: `docs-snippets: ${String(result.value.length)} error(s) across ${String(new Set(result.value.map((f) => f.file.split("/").pop() ?? "")).size)} file(s)`,
		);
		return clean ? 0 : 1;
	} finally {
		await rm(dir.value, { recursive: true, force: true });
	}
};

process.exitCode = await main();
