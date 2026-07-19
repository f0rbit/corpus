import { parseArgs } from "node:util";

export type CommandName = "stores" | "versions" | "show" | "cat" | "lineage" | "clone";

export type CommandSpec = {
	positionals?: string[];
	options?: Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>;
};

export type GlobalArgs = {
	env?: string;
	file?: string;
	config?: string;
	json: boolean;
	help: boolean;
	command?: CommandName;
	args?: Record<string, unknown>;
	positionals?: string[];
};

const GLOBAL_OPTIONS = {
	env: { type: "string" as const, short: "e" },
	file: { type: "string" as const, short: "f" },
	config: { type: "string" as const, short: "c" },
	json: { type: "boolean" as const, default: false },
	help: { type: "boolean" as const, short: "h", default: false },
};

export function parse_global_args(argv: string[]): GlobalArgs {
	const { values, positionals } = parseArgs({
		argv,
		options: GLOBAL_OPTIONS,
		strict: false,
	});

	const command_name = positionals[0] as CommandName | undefined;

	return {
		env: values.env as string | undefined,
		file: values.file as string | undefined,
		config: values.config as string | undefined,
		json: (values.json as boolean) || false,
		help: (values.help as boolean) || false,
		command: command_name,
		positionals: positionals.slice(command_name ? 1 : 0),
	};
}

export function parse_command_args(
	argv: string[],
	spec: CommandSpec,
): { args: Record<string, unknown>; positionals: string[] } {
	const options = spec.options ?? {};
	const { values, positionals } = parseArgs({
		argv,
		options,
		strict: true,
	});

	return { args: values, positionals };
}
