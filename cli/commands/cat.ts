import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const cat_command: Command = {
	name: "cat",
	summary: "Output snapshot data (decoded or raw)",
	spec: {
		positionals: ["store", "version"],
		options: {
			raw: { type: "boolean" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
