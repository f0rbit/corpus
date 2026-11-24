import type { MutationManifest } from "./types.js";

const main = "cli/main.ts";

export const manifest = {
	cluster: "cli-main",
	old_tests: ["tests/integration/cli-entrypoint.test.ts", "tests/unit/cli-output.test.ts"],
	new_tests: [
		"tests/integration/cli-entrypoint.test.ts",
		"tests/unit/cli-output.test.ts",
		"tests/unit/cli-main.test.ts",
	],
	mutations: [
		{
			id: "cli-main/unknown-command-exit-1",
			file: main,
			find: "output.error(`Unknown command: ${global_args.command}`);\n\t\treturn 2;",
			replace: "output.error(`Unknown command: ${global_args.command}`);\n\t\treturn 1;",
			guards: "an unknown command exits 2 (usage error), not 1",
		},
		{
			id: "cli-main/help-exits-1",
			file: main,
			find: "render_usage(output, global_args.command);\n\t\treturn 0;",
			replace: "render_usage(output, global_args.command);\n\t\treturn 1;",
			guards: "--help exits 0",
		},
		{
			id: "cli-main/no-color-reads-ci",
			file: main,
			find: "no_color: io.env.NO_COLOR !== undefined,",
			replace: "no_color: io.env.CI !== undefined,",
			guards: "NO_COLOR (not CI) disables colour",
		},
		{
			id: "cli-main/load-config-ignores-cwd",
			file: "cli/load-config.ts",
			find: 'find_upward(cwd, "corpus.config.ts")',
			replace: 'find_upward(process.cwd(), "corpus.config.ts")',
			guards: "config discovery searches upward from the injected cwd",
		},
		{
			id: "cli-main/drops-json-passthrough",
			file: main,
			find: "json: global_args.json,\n\t});",
			replace: "json: false,\n\t});",
			guards: "--json reaches the command context so it emits its documented document",
		},
		{
			id: "cli-main/fatal-debug-forced-off",
			file: main,
			find: 'io.env.CORPUS_DEBUG === "1"',
			replace: "false",
			guards: "CORPUS_DEBUG=1 prints the stack for unexpected throws",
		},
		{
			id: "cli-main/command-error-exits-0",
			file: main,
			find: "output.error(command_result.error);\n\t\treturn 1;",
			replace: "output.error(command_result.error);\n\t\treturn 0;",
			guards: "a failing command exits 1",
		},
		{
			id: "cli-main/stdout-sink-not-injected",
			file: main,
			find: "...(io.stdout_write && { stdout_write: io.stdout_write }),",
			replace: "",
			guards: "stdout writes go through the injected sink",
		},
	],
} satisfies MutationManifest;
