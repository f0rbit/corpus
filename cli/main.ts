import type { GlobalArgs } from "./args.js";
import type { Output } from "./output.js";
import type { BackendSelector } from "./resolve-backend.js";
import type { CorpusError } from "../types.js";
import { parse_global_args, parse_command_args } from "./args.js";
import { get_command, get_all_commands } from "./commands/index.js";
import { create_console_output, write_fatal } from "./output.js";
import { try_catch_async } from "../result.js";

// Everything the CLI knows about its process. Only cli/index.ts reads the
// real `process.*`; tests hand in plain values and capture sinks.
export type CliIo = {
	argv: readonly string[];
	env: Record<string, string | undefined>;
	cwd: string;
	stdout_is_tty: boolean;
	stderr_is_tty: boolean;
	stdout_write?: (chunk: string | Uint8Array) => void;
	stderr_write?: (chunk: string) => void;
};

export function build_backend_selector(g: GlobalArgs): BackendSelector & { config?: string } {
	return {
		...(g.env !== undefined && { env: g.env }),
		...(g.file !== undefined && { file: g.file }),
		...(g.config !== undefined && { config: g.config }),
	};
}

function render_usage(output: Output, command_name?: string): void {
	if (command_name) {
		const command = get_command(command_name);
		if (!command) {
			output.line(`Unknown command: ${command_name}`);
			return;
		}
		output.line(`Usage: corpus ${command.name} [options]`);
		output.line(command.summary);
		return;
	}

	output.line("Usage: corpus <command> [options]");
	output.line("");
	output.line("Commands:");
	const commands = get_all_commands();
	for (const cmd of commands) {
		output.line(`  ${cmd.name.padEnd(12)} ${cmd.summary}`);
	}
	output.line("");
	output.line("Global options:");
	output.line("  --env, -e          Environment name");
	output.line("  --file, -f         File backend path");
	output.line("  --config, -c       Config file path");
	output.line("  --json              Output JSON");
	output.line("  --quiet, -q         Suppress decorative notes and spinners");
	output.line("  --help, -h          Show help");
}

async function execute(io: CliIo): Promise<number> {
	const global_args = parse_global_args([...io.argv]);
	// Enable matrix computed once, here — output/spinner code never reads TTY
	// state or env vars ambiently (f0rbit/no-ambient-effects + injectability).
	const output = create_console_output({
		json: global_args.json,
		quiet: global_args.quiet,
		stdout_is_tty: io.stdout_is_tty,
		stderr_is_tty: io.stderr_is_tty,
		no_color: io.env.NO_COLOR !== undefined,
		ci: io.env.CI !== undefined,
		...(io.stdout_write && { stdout_write: io.stdout_write }),
		...(io.stderr_write && { stderr_write: io.stderr_write }),
	});

	if (global_args.help) {
		render_usage(output, global_args.command);
		return 0;
	}

	if (!global_args.command) {
		render_usage(output, undefined);
		return 2;
	}

	const command = get_command(global_args.command);
	if (!command) {
		output.error(`Unknown command: ${global_args.command}`);
		return 2;
	}

	const parse_result = await try_catch_async(
		async () => {
			return parse_command_args(global_args.positionals, command.spec);
		},
		(error): CorpusError => ({
			kind: "invalid_config",
			message: error instanceof Error ? error.message : String(error),
		}),
	);

	if (!parse_result.ok) {
		output.error(parse_result.error);
		return 1;
	}

	const { args, positionals } = parse_result.value;
	const command_result = await command.run({
		args,
		positionals,
		backend_selector: build_backend_selector(global_args),
		output,
		cwd: io.cwd,
		env_vars: io.env,
		json: global_args.json,
	});

	if (!command_result.ok) {
		output.error(command_result.error);
		return 1;
	}
	return 0;
}

export async function run_cli(io: CliIo): Promise<number> {
	const result = await try_catch_async(
		() => execute(io),
		(error: unknown): unknown => error,
	);
	if (result.ok) return result.value;
	write_fatal(result.error, io.env.CORPUS_DEBUG === "1", io.stderr_write);
	return 1;
}
