import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { ok, err } from "../../types.js";
import { resolve_backend } from "../resolve-backend.js";
import { sniff_wrangler } from "../wrangler.js";
import { load_cli_config } from "../load-config.js";
import { z } from "zod";

const date_schema = z.string().datetime().transform((s) => new Date(s));

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
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		try {
			const store_id = ctx.positionals[0];
			if (!store_id) {
				return err({
					kind: "validation_error",
					message: "store argument is required",
					cause: new Error("missing positional argument"),
				});
			}

			// Parse and validate date flags
			let before_date: Date | undefined;
			let after_date: Date | undefined;

			if (typeof ctx.args.before === "string") {
				const parse_result = date_schema.safeParse(ctx.args.before);
				if (!parse_result.success) {
					return err({
						kind: "validation_error",
						message: `invalid --before date: ${ctx.args.before}`,
						cause: new Error("failed to parse ISO-8601 date"),
					});
				}
				before_date = parse_result.data;
			}

			if (typeof ctx.args.after === "string") {
				const parse_result = date_schema.safeParse(ctx.args.after);
				if (!parse_result.success) {
					return err({
						kind: "validation_error",
						message: `invalid --after date: ${ctx.args.after}`,
						cause: new Error("failed to parse ISO-8601 date"),
					});
				}
				after_date = parse_result.data;
			}

			let limit: number | undefined;
			if (typeof ctx.args.limit === "string") {
				const parsed = parseInt(ctx.args.limit, 10);
				if (isNaN(parsed) || parsed < 1) {
					return err({
						kind: "validation_error",
						message: `invalid --limit: must be a positive number`,
						cause: new Error("limit must be ≥ 1"),
					});
				}
				limit = parsed;
			}

			 
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

			const spin = ctx.output.spinner("Loading versions...");

			const versions: Array<Record<string, string>> = [];
			const full_metas: Array<{ version: string; created_at: string; size_bytes: number; content_hash: string; tags?: string[] }> = [];

			const tags = Array.isArray(ctx.args.tag) ? ctx.args.tag : ctx.args.tag ? [ctx.args.tag] : [];

			for await (const meta of backend.metadata.list(store_id, { limit, before: before_date, after: after_date, tags: tags.length > 0 ? tags : undefined })) {
				const version_row = {
					version: meta.version,
					created_at: meta.created_at.toISOString(),
					size_bytes: String(meta.size_bytes),
					content_hash: meta.content_hash.slice(0, 12),
					tags: meta.tags?.join(", ") ?? "",
				};
				versions.push(version_row);
				full_metas.push({
					version: meta.version,
					created_at: meta.created_at.toISOString(),
					size_bytes: meta.size_bytes,
					content_hash: meta.content_hash,
					tags: meta.tags,
				});
			}

			spin.stop();

			ctx.output.table(versions, ["version", "created_at", "size_bytes", "content_hash", "tags"]);
			ctx.output.json({
				store: store_id,
				versions: full_metas,
			});

			return ok(undefined);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return err({
				kind: "storage_error",
				operation: "list",
				cause: new Error(message),
			});
		}
	},
};
