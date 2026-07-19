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
	quiet: boolean;
	help: boolean;
	command?: CommandName;
	args?: Record<string, unknown>;
	positionals: string[];
};

const GLOBAL_OPTIONS = {
	env: { type: "string" as const, short: "e" },
	file: { type: "string" as const, short: "f" },
	config: { type: "string" as const, short: "c" },
	json: { type: "boolean" as const, default: false },
	quiet: { type: "boolean" as const, short: "q", default: false },
	help: { type: "boolean" as const, short: "h", default: false },
};

const GLOBAL_OPTION_NAMES = new Set(Object.keys(GLOBAL_OPTIONS));

// Two-stage parse: this pass only owns GLOBAL_OPTIONS. `strict: false` is
// required to tolerate command-specific flags (--counts, --raw, --tag, ...)
// appearing anywhere in argv, but node's parseArgs treats every unconfigured
// long option as a standalone boolean in that mode — it does NOT thread a
// following bare word through as that option's value, so e.g. `--limit 5`
// comes back as option "limit" (no value) + a *separate* positional "5".
// Reconstructing the leftover argv from `tokens` (rather than trusting the
// `positionals` array parseArgs returns) is what lets a value like that "5"
// survive in its original position for parse_command_args's real, strict
// per-command parse to pick up correctly.
export function parse_global_args(argv: string[]): GlobalArgs {
	const { values, tokens } = parseArgs({
		args: argv,
		options: GLOBAL_OPTIONS,
		strict: false,
		tokens: true,
		allowPositionals: true,
	});

	let command_name: string | undefined;
	const rest: string[] = [];

	for (const token of tokens) {
		if (token.kind === "positional") {
			if (command_name === undefined) {
				command_name = token.value;
			} else {
				rest.push(token.value);
			}
			continue;
		}
		if (token.kind === "option" && !GLOBAL_OPTION_NAMES.has(token.name)) {
			rest.push(token.inlineValue ? `${token.rawName}=${token.value}` : token.rawName);
		}
	}

	return {
		env: values.env as string | undefined,
		file: values.file as string | undefined,
		config: values.config as string | undefined,
		json: (values.json as boolean) || false,
		quiet: (values.quiet as boolean) || false,
		help: (values.help as boolean) || false,
		command: command_name as CommandName | undefined,
		positionals: rest,
	};
}

export function parse_command_args(
	argv: string[],
	spec: CommandSpec,
): { args: Record<string, unknown>; positionals: string[] } {
	const options = spec.options ?? {};
	const { values, positionals } = parseArgs({
		args: argv,
		options,
		strict: true,
		allowPositionals: true,
	});

	return { args: values, positionals };
}
