import type { MutationManifest } from "./types.js";

const resolve = "cli/resolve-backend.ts";
const r2 = "backend/remote-r2.ts";
const lineage = "cli/commands/lineage.ts";
const tests = [
	"tests/unit/cli-output.test.ts",
	"tests/integration/remote-errors.test.ts",
	"tests/integration/cli-errors.test.ts",
	"tests/integration/cli-entrypoint.test.ts",
];

export const manifest = {
	cluster: "live-fixes",
	old_tests: tests,
	new_tests: tests,
	mutations: [
		{
			id: "live-fixes/note-on-stdout",
			file: "cli/output.ts",
			find: "stderr_write(`${note_ansi.dim(text)}\\n`);",
			replace: "stdout_write(`${note_ansi.dim(text)}\\n`);",
			guards: "note() is decoration and goes to stderr, keeping `cat | jq` parseable",
		},
		{
			id: "live-fixes/no-credentialless-data-client",
			file: resolve,
			find: "has_r2_credentials ? remote : { ...remote, data: credentialless_data() }",
			replace: "remote",
			guards: "missing R2 creds fail data ops with an error naming both env vars",
		},
		{
			id: "live-fixes/one-r2-credential-is-enough",
			file: resolve,
			find: "const has_r2_credentials = !!access_key_id && !!secret_access_key;",
			replace: "const has_r2_credentials = !!access_key_id || !!secret_access_key;",
			guards: "a half-configured credential pair is still missing credentials",
		},
		{
			id: "live-fixes/credential-message-drops-env-vars",
			file: resolve,
			find: "requires the CORPUS_R2_ACCESS_KEY_ID and CORPUS_R2_SECRET_ACCESS_KEY env vars",
			replace: "requires R2 credentials",
			guards: "the missing-credentials message names both env vars",
		},
		{
			id: "live-fixes/r2-builds-client-with-empty-credentials",
			file: r2,
			find: "if (!config.access_key_id || !config.secret_access_key) {",
			replace: "if (false as boolean) {",
			guards: "remote-r2 never constructs an S3 client with empty credentials",
		},
		{
			id: "live-fixes/r2-probe-error-as-miss",
			file: r2,
			find: "if (!(await file.exists())) return null;",
			replace: "if (!(await file.exists().catch(() => false))) return null;",
			guards: "an auth/5xx existence probe is storage_error, not not_found",
		},
		{
			id: "live-fixes/data-not-found-key-as-store",
			file: "backend/errors.ts",
			find: 'store_id: data_key.split("/")[0] || data_key,',
			replace: "store_id: data_key,",
			guards: "data-client not_found names the store prefix, not the whole key",
		},
		{
			id: "live-fixes/lineage-ignores-latest",
			file: lineage,
			find: "const root_result = await resolve_meta(backend, store_id, version);",
			replace: "const root_result = await backend.metadata.get(store_id, version);",
			guards: "lineage resolves `latest` like show/cat",
		},
		{
			id: "live-fixes/lineage-walks-literal-version",
			file: lineage,
			find: "await visit(store_id, root_version, 0);",
			replace: "await visit(store_id, version, 0);",
			guards: "lineage walks from the resolved root version",
		},
	],
} satisfies MutationManifest;
