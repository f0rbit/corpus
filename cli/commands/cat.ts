import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { err, ok } from "../../types.js";
import { try_catch_async } from "../../result.js";
import { load_cli_config } from "../load-config.js";
import { sniff_wrangler } from "../wrangler.js";
import { resolve_backend } from "../resolve-backend.js";

export const cat_command: Command = {
	name: "cat",
	summary: "Output snapshot data (decoded or raw)",
	spec: {
		positionals: ["store", "version"],
		options: {
			raw: { type: "boolean" },
		},
	},
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		const store_id = ctx.positionals[0];
		const version = ctx.positionals[1];
		const raw = (ctx.args.raw as boolean) || false;

		if (!store_id || !version) {
			return err({
				kind: "invalid_config",
				message: "cat requires <store> and <version> arguments",
			});
		}

		// Resolve version alias
		const actual_version = version === "latest" ? undefined : version;

		// Load config and wrangler
		const config_result = await load_cli_config(ctx.backend_selector.config);
		if (!config_result.ok) return config_result;

		const wrangler_result = await sniff_wrangler(ctx.cwd);
		if (!wrangler_result.ok) return wrangler_result;

		// Resolve backend
		const backend_result = await resolve_backend(ctx.backend_selector, wrangler_result.value, {
			config: config_result.value,
			env_vars: ctx.env_vars,
			cwd: ctx.cwd,
		});
		if (!backend_result.ok) return backend_result;

		const backend = backend_result.value;

		// Get metadata
		const meta_result = actual_version
			? await backend.metadata.get(store_id, actual_version)
			: await backend.metadata.get_latest(store_id);

		if (!meta_result.ok) return meta_result;

		const meta = meta_result.value;

		// Handle raw output
		if (raw) {
			const data_result = await backend.data.get(meta.data_key);
			if (!data_result.ok) return data_result;

			const handle = data_result.value;
			const bytes = await handle.bytes();
			ctx.output.bytes(bytes);
			return ok(undefined);
		}

		// Try to decode using config
		const config = config_result.value;
		const store_def = config?.stores?.find((s) => s.id === store_id);

		// Check if we have a store definition with a decode function
		if (
			store_def &&
			store_def.codec &&
			typeof store_def.codec === "object" &&
			"decode" in store_def.codec &&
			typeof (store_def.codec as Record<string, unknown>).decode === "function"
		) {
			const data_result = await backend.data.get(meta.data_key);
			if (!data_result.ok) return data_result;

			const handle = data_result.value;
			const bytes = await handle.bytes();

			const decode_fn = (store_def.codec as Record<string, unknown>).decode as (data: Uint8Array) => Promise<unknown>;

			const decode_result = await try_catch_async(
				() => decode_fn(bytes),
				(error): CorpusError => ({
					kind: "decode_error",
					cause: error instanceof Error ? error : new Error(String(error)),
				}),
			);
			if (!decode_result.ok) return decode_result;

			ctx.output.line(JSON.stringify(decode_result.value, null, 2));
			return ok(undefined);
		}

		// Fallback: use content_type from meta
		if (meta.content_type.startsWith("text/")) {
			ctx.output.note("(no corpus.config.ts — rendered from content_type, not a codec)");
			const data_result = await backend.data.get(meta.data_key);
			if (!data_result.ok) return data_result;

			const handle = data_result.value;
			const bytes = await handle.bytes();
			const text = new TextDecoder().decode(bytes);
			ctx.output.line(text);
			return ok(undefined);
		}

		if (meta.content_type === "application/json") {
			ctx.output.note("(no corpus.config.ts — rendered from content_type, not a codec)");
			const data_result = await backend.data.get(meta.data_key);
			if (!data_result.ok) return data_result;

			const handle = data_result.value;
			const bytes = await handle.bytes();

			const parse_result = await try_catch_async(
				async () => {
					const decoded = new TextDecoder().decode(bytes);
					// structuredClone is safe for JSON values per f0rbit/require-schema-at-boundary
					return structuredClone(JSON.parse(decoded) as unknown);
				},
				(error): CorpusError => ({
					kind: "decode_error",
					cause: error instanceof Error ? error : new Error(String(error)),
				}),
			);
			if (!parse_result.ok) return parse_result;

			ctx.output.line(JSON.stringify(parse_result.value, null, 2));
			return ok(undefined);
		}

		// Binary or unknown content type without config
		return err({
			kind: "invalid_config",
			message: `cannot render ${meta.content_type} without a codec. Use --raw to stream bytes, or add the store to corpus.config.ts with a decode function.`,
		});
	},
};
