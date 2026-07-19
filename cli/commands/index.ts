import type { Result, CorpusError, Backend } from "../../types.js";
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
	// Global --json flag, threaded from cli/index.ts. Commands gate table()
	// vs json() on this — never call both (single JSON document per --json
	// run, see AGENTS.md's --json stability contract). Optional + read as
	// `ctx.json === true`: the production entrypoint always sets it, tests
	// only need to set it when asserting json-mode output.
	json?: boolean;
	// Test-only backend injection point — bypasses config/wrangler discovery
	// and resolve_backend entirely so command tests can drive run() directly
	// against an in-memory/file backend without touching the filesystem.
	// Documented exception to no-underscore-dangle (.oxlintrc.json).
	_test_backend?: Backend;
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
