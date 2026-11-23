import type { MutationManifest } from "./types.js";

const tests = ["tests/unit/cli-output.test.ts", "tests/unit/cli-config.test.ts", "tests/unit/cli-args.test.ts"];
const output = "cli/output.ts";
const resolve = "cli/resolve-backend.ts";

export const manifest = {
	cluster: "cli-policy",
	old_tests: tests,
	new_tests: tests,
	mutations: [
		{
			id: "cli-policy/color-ignores-no-color",
			file: output,
			find: "const color = opts.stdout_is_tty && !opts.json && !opts.no_color;",
			replace: "const color = opts.stdout_is_tty && !opts.json;",
			guards: "colour is off when NO_COLOR is set",
		},
		{
			id: "cli-policy/color-reads-stderr-tty",
			file: output,
			find: "const color = opts.stdout_is_tty &&",
			replace: "const color = opts.stderr_is_tty &&",
			guards: "colour is gated on the stdout TTY, not stderr",
		},
		{
			id: "cli-policy/spinner-ignores-ci",
			file: output,
			find: "&& !opts.quiet && !opts.ci && !opts.no_color;",
			replace: "&& !opts.quiet && !opts.no_color;",
			guards: "spinner is disabled under CI",
		},
		{
			id: "cli-policy/spinner-ignores-quiet",
			file: output,
			find: "!opts.json && !opts.quiet && !opts.ci",
			replace: "!opts.json && !opts.ci",
			guards: "spinner is disabled by --quiet",
		},
		{
			id: "cli-policy/env-outranks-config",
			file: resolve,
			find: '(env_config && "database_id" in env_config ? env_config.database_id : undefined) ||\n\t\tenv_vars.CORPUS_D1_DATABASE_ID ||',
			replace:
				'env_vars.CORPUS_D1_DATABASE_ID ||\n\t\t(env_config && "database_id" in env_config ? env_config.database_id : undefined) ||',
			guards: "explicit config entry outranks CORPUS_D1_DATABASE_ID",
		},
		{
			id: "cli-policy/sniff-takes-first-candidate",
			file: resolve,
			find: "wrangler_sniff?.d1_candidates.find((c) => uuid_pattern.test(c.database_id))?.database_id",
			replace: "wrangler_sniff?.d1_candidates[0]?.database_id",
			guards: "sniffed placeholder ids are skipped in favour of a UUID candidate",
		},
		{
			id: "cli-policy/placeholder-error-disabled",
			file: resolve,
			find: "if (!database_id && placeholder) {",
			replace: "if (!database_id && placeholder && false) {",
			guards: "placeholder-only wrangler sniff is invalid_config naming the file and the fix",
		},
		{
			id: "cli-policy/args-inline-value-dropped",
			file: "cli/args.ts",
			find: "rest.push(token.inlineValue ? `${token.rawName}=${token.value}` : token.rawName);",
			replace: "rest.push(token.rawName);",
			guards: "inline --flag=value is re-emitted with its value for the command parse",
		},
	],
} satisfies MutationManifest;
