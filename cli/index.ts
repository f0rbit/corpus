#!/usr/bin/env bun

import type { Output } from "./output.js";
import { parse_global_args, parse_command_args } from "./args.js";
import { get_command, get_all_commands } from "./commands/index.js";
import { create_console_output } from "./output.js";
import { try_catch_async } from "../result.js";
import type { CorpusError } from "../types.js";

async function main(): Promise<void> {
	const global_args = parse_global_args(process.argv.slice(2));
	const output = create_console_output({ json_mode: global_args.json });

	if (global_args.help) {
		render_usage(output, global_args.command);
		process.exit(0);
		return;
	}

	if (!global_args.command) {
		render_usage(output, undefined);
		process.exit(2);
		return;
	}

	const command = get_command(global_args.command);
	if (!command) {
		output.error(`Unknown command: ${global_args.command}`);
		process.exit(2);
		return;
	}

	const parse_result = await try_catch_async(
		async () => {
			return parse_command_args([...(global_args.positionals ?? [])], command.spec);
		},
		(error): CorpusError => ({
			kind: "invalid_config",
			message: error instanceof Error ? error.message : String(error),
		}),
	);

	if (!parse_result.ok) {
		output.error(parse_result.error);
		process.exit(1);
		return;
	}

	const { args, positionals } = parse_result.value;
	const command_result = await command.run({
		args,
		positionals,
		backend_selector: {
			env: global_args.env,
			file: global_args.file,
			config: global_args.config,
		},
		output,
		cwd: process.cwd(),
		env_vars: process.env,
	});

	if (!command_result.ok) {
		output.error(command_result.error);
		process.exit(1);
	} else {
		process.exit(0);
	}
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
	output.line("  --help, -h          Show help");
}

main().catch(() => {
	process.exit(1);
});
