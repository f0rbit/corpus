import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { ok, err } from "../../types.js";
import { resolve_backend } from "../resolve-backend.js";
import { sniff_wrangler } from "../wrangler.js";
import { load_cli_config } from "../load-config.js";

export const stores_command: Command = {
	name: "stores",
	summary: "List all stores",
	spec: {
		options: {
			counts: { type: "boolean" },
		},
	},
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		 
		let backend = ctx._test_backend;

		if (!backend) {
			const wrangler_result = await sniff_wrangler(ctx.cwd);
			if (!wrangler_result.ok) {
				return wrangler_result;
			}
			const wrangler = wrangler_result.value;

			const config_result = await load_cli_config(ctx.cwd);
			if (!config_result.ok) {
				return config_result;
			}
			const config = config_result.value;

			const backend_result = await resolve_backend(
				ctx.backend_selector,
				wrangler,
				{
					config,
					env_vars: ctx.env_vars,
					cwd: ctx.cwd,
				},
			);

			if (!backend_result.ok) {
				return backend_result;
			}

			backend = backend_result.value;
		}

		// Check if list_stores is available
		if (!backend.metadata.list_stores) {
			return err({
				kind: "invalid_config",
				message: "backend does not support store enumeration (try resolving to a file or memory backend)",
			});
		}

		const spin = ctx.output.spinner("Loading stores...");

		const stores_list: Array<{
			id: string;
			version_count?: string;
			latest_created_at?: string;
		}> = [];

		// Collect all store ids
		for await (const store_id of backend.metadata.list_stores()) {
			stores_list.push({ id: store_id });
		}

		// If --counts flag is set, fetch version counts and latest created_at
		if (ctx.args.counts) {
			for (const store of stores_list) {
				let version_count = 0;
				let latest_created_at: Date | undefined;

				for await (const meta of backend.metadata.list(store.id)) {
					version_count += 1;
					if (!latest_created_at || meta.created_at > latest_created_at) {
						latest_created_at = meta.created_at;
					}
				}

				store.version_count = String(version_count);
				if (latest_created_at) {
					store.latest_created_at = latest_created_at.toISOString();
				}
			}
		}

		spin.stop();

		// Output results
		if (ctx.args.counts) {
			ctx.output.table(stores_list, ["id", "version_count", "latest_created_at"]);
		} else {
			ctx.output.table(
				stores_list.map((s) => ({ id: s.id })),
				["id"],
			);
		}

		// JSON output
		ctx.output.json({ stores: stores_list });

		return ok(undefined);
	},
};
