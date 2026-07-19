import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const stores_command: Command = {
	name: "stores",
	summary: "List all stores",
	spec: {
		options: {
			counts: { type: "boolean" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
