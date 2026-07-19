import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { ok, err } from "../../types.js";
import { resolve_backend } from "../resolve-backend.js";
import { sniff_wrangler } from "../wrangler.js";
import { load_cli_config } from "../load-config.js";

export const show_command: Command = {
	name: "show",
	summary: "Show metadata for a snapshot version",
	spec: {
		positionals: ["store", "version"],
		options: {
			observations: { type: "boolean" },
		},
	},
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		try {
			const store_id = ctx.positionals[0];
			const version = ctx.positionals[1];

			if (!store_id || !version) {
				return err({
					kind: "validation_error",
					message: "store and version arguments are required",
					cause: new Error("missing positional arguments"),
				});
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

			// Get the snapshot metadata
			const meta_result = await backend.metadata.get(store_id, version);
			if (!meta_result.ok) {
				return meta_result;
			}

			const meta = meta_result.value;

			// Format metadata as rows
			const meta_rows: Record<string, string>[] = [
				{ key: "Store ID", value: meta.store_id },
				{ key: "Version", value: meta.version },
				{ key: "Created At", value: meta.created_at.toISOString() },
				...(meta.invoked_at ? [{ key: "Invoked At", value: meta.invoked_at.toISOString() }] : []),
				{ key: "Content Hash", value: meta.content_hash },
				{ key: "Content Type", value: meta.content_type },
				{ key: "Size Bytes", value: String(meta.size_bytes) },
				{ key: "Data Key", value: meta.data_key },
				...(meta.tags && meta.tags.length > 0 ? [{ key: "Tags", value: meta.tags.join(", ") }] : []),
			];

			// Add parents
			if (meta.parents.length > 0) {
				meta_rows.push({ key: "Parents", value: "" });
				for (const parent of meta.parents) {
					const parent_label = parent.role ? `${parent.store_id}/${parent.version} (${parent.role})` : `${parent.store_id}/${parent.version}`;
					meta_rows.push({ key: "", value: parent_label });
				}
			}

			// Render metadata
			ctx.output.table(meta_rows, ["key", "value"]);

			// Fetch and render observations if requested
			if (ctx.args.observations) {
				if (!backend.observations) {
					ctx.output.note("Observations not enabled for this backend");
				} else {
					const obs_rows: Record<string, string>[] = [];

					for await (const obs_meta of backend.observations.query_meta({
						source_store: store_id,
						source_version: version,
					})) {
						obs_rows.push({
							id: obs_meta.id,
							type: obs_meta.type,
							created_at: obs_meta.created_at.toISOString(),
							path: obs_meta.source?.path ?? "",
							span: obs_meta.source?.span ? `${String(obs_meta.source.span.start)}-${String(obs_meta.source.span.end)}` : "",
						});
					}

					if (obs_rows.length > 0) {
						ctx.output.line("");
						ctx.output.table(obs_rows, ["id", "type", "created_at", "path", "span"]);
					}
				}
			}

			// JSON output
			const obs_list: Array<Record<string, unknown>> = [];
			if (ctx.args.observations && backend.observations) {
				for await (const obs_meta of backend.observations.query_meta({
					source_store: store_id,
					source_version: version,
				})) {
					obs_list.push({
						id: obs_meta.id,
						type: obs_meta.type,
						created_at: obs_meta.created_at.toISOString(),
						source: obs_meta.source,
						confidence: obs_meta.confidence,
						observed_at: obs_meta.observed_at?.toISOString(),
					});
				}
			}

			const json_output: Record<string, unknown> = {
				meta: {
					store_id: meta.store_id,
					version: meta.version,
					created_at: meta.created_at.toISOString(),
					invoked_at: meta.invoked_at?.toISOString(),
					content_hash: meta.content_hash,
					content_type: meta.content_type,
					size_bytes: meta.size_bytes,
					data_key: meta.data_key,
					tags: meta.tags,
					parents: meta.parents,
				},
			};

			if (obs_list.length > 0) {
				json_output.observations = obs_list;
			}

			ctx.output.json(json_output);

			return ok(undefined);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return err({
				kind: "storage_error",
				operation: "get",
				cause: new Error(message),
			});
		}
	},
};
