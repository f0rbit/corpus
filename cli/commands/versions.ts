import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError, SnapshotMeta } from "../../types.js";
import { ok, err } from "../../types.js";
import { resolve_backend } from "../resolve-backend.js";
import { sniff_wrangler } from "../wrangler.js";
import { load_cli_config } from "../load-config.js";
import { serialize_meta } from "../meta.js";
import { z } from "zod";

const date_schema = z
	.string()
	.datetime()
	.transform((s) => new Date(s));

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
		const store_id = ctx.positionals[0];
		if (!store_id) {
			return err({
				kind: "validation_error",
				message: "store argument is required",
				cause: new Error("missing positional argument"),
			});
		}

		let before_date: Date | undefined;
		if (typeof ctx.args.before === "string") {
			const parsed = date_schema.safeParse(ctx.args.before);
			if (!parsed.success) {
				return err({
					kind: "validation_error",
					message: `invalid --before date: ${ctx.args.before}`,
					cause: new Error("failed to parse ISO-8601 date"),
				});
			}
			before_date = parsed.data;
		}

		let after_date: Date | undefined;
		if (typeof ctx.args.after === "string") {
			const parsed = date_schema.safeParse(ctx.args.after);
			if (!parsed.success) {
				return err({
					kind: "validation_error",
					message: `invalid --after date: ${ctx.args.after}`,
					cause: new Error("failed to parse ISO-8601 date"),
				});
			}
			after_date = parsed.data;
		}

		let limit: number | undefined;
		if (typeof ctx.args.limit === "string") {
			const parsed = parseInt(ctx.args.limit, 10);
			if (isNaN(parsed) || parsed < 1) {
				return err({
					kind: "validation_error",
					message: "invalid --limit: must be a positive number",
					cause: new Error("limit must be >= 1"),
				});
			}
			limit = parsed;
		}

		let backend = ctx._test_backend;

		if (!backend) {
			const wrangler_result = await sniff_wrangler(ctx.cwd);
			if (!wrangler_result.ok) return wrangler_result;
			const wrangler = wrangler_result.value;

			const config_result = await load_cli_config(ctx.cwd);
			if (!config_result.ok) return config_result;
			const config = config_result.value;

			const backend_result = await resolve_backend(ctx.backend_selector, wrangler, {
				config,
				env_vars: ctx.env_vars,
				cwd: ctx.cwd,
			});
			if (!backend_result.ok) return backend_result;

			backend = backend_result.value;
		}

		const tags = Array.isArray(ctx.args.tag) ? ctx.args.tag : ctx.args.tag ? [ctx.args.tag] : [];

		const spin = ctx.output.spinner("Loading versions...");

		const metas: SnapshotMeta[] = [];
		for await (const meta of backend.metadata.list(store_id, {
			limit,
			before: before_date,
			after: after_date,
			tags: tags.length > 0 ? tags : undefined,
		})) {
			metas.push(meta);
		}

		spin.stop();

		if (ctx.json) {
			ctx.output.json({ store: store_id, versions: metas.map(serialize_meta) });
			return ok(undefined);
		}

		ctx.output.table(
			metas.map((meta) => ({
				version: meta.version,
				created_at: meta.created_at.toISOString(),
				size_bytes: String(meta.size_bytes),
				content_hash: meta.content_hash.slice(0, 12),
				tags: meta.tags?.join(", ") ?? "",
			})),
			["version", "created_at", "size_bytes", "content_hash", "tags"],
		);

		return ok(undefined);
	},
};
