import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const show_command: Command = {
	name: "show",
	summary: "Show metadata for a snapshot version",
	spec: {
		positionals: ["store", "version"],
		options: {
			observations: { type: "boolean" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
