import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const clone_command: Command = {
	name: "clone",
	summary: "Clone snapshots from source to destination backend",
	spec: {
		positionals: ["source", "dest"],
		options: {
			store: { type: "string", multiple: true },
			tag: { type: "string", multiple: true },
			"dry-run": { type: "boolean" },
			concurrency: { type: "string" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
