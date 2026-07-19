import type { Result, CorpusError } from "../../types.js";
import type { Output } from "../output.js";
import type { CommandSpec, CommandName } from "../args.js";

export type CommandContext = {
	args: Record<string, unknown>;
	positionals: string[];
	backend_selector: {
		env?: string;
		file?: string;
		config?: string;
	};
	output: Output;
	cwd: string;
	env_vars: Record<string, string | undefined>;
};

export type Command = {
	name: CommandName;
	summary: string;
	spec: CommandSpec;
	run(ctx: CommandContext): Promise<Result<void, CorpusError>>;
};

import { stores_command } from "./stores.js";
import { versions_command } from "./versions.js";
import { show_command } from "./show.js";
import { cat_command } from "./cat.js";
import { lineage_command } from "./lineage.js";
import { clone_command } from "./clone.js";

export const command_registry: Record<CommandName, Command> = {
	stores: stores_command,
	versions: versions_command,
	show: show_command,
	cat: cat_command,
	lineage: lineage_command,
	clone: clone_command,
};

export function get_command(name: string): Command | undefined {
	return command_registry[name as CommandName];
}

export function get_all_commands(): Command[] {
	return Object.values(command_registry);
}
