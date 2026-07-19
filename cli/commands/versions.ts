import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err } from "../../types.js";

export const versions_command: Command = {
	name: "versions",
	summary: "List versions in a store",
	spec: {
		positionals: ["store"],
		options: {
			tag: { type: "string", multiple: true },
			limit: { type: "string" },
			before: { type: "string" },
			after: { type: "string" },
		},
	},
	async run(_ctx: CommandContext): Promise<Result<void, CorpusError>> {
		return err({
			kind: "invalid_config",
			message: "not implemented",
		});
	},
};
