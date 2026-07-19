import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const lineage_command: Command = {
	name: "lineage",
	summary: "Show parent lineage for a snapshot version",
	spec: {
		positionals: ["store", "version"],
		options: {
			depth: { type: "string" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
