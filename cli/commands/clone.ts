import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import type { Backend } from "../../types.js";
import { err, ok } from "../../types.js";
import { try_catch_async } from "../../result.js";
import { copy, type CopyProgressEvent } from "../../copy.js";
import { load_cli_config } from "../load-config.js";
import { sniff_wrangler } from "../wrangler.js";
import { resolve_backend } from "../resolve-backend.js";
import type { CorpusCliConfig } from "../config-schema.js";

async function resolve_selector(
	selector: string,
	backend_selector: { env?: string; file?: string; config?: string },
	config: CorpusCliConfig | null,
	env_vars: Record<string, string | undefined>,
	cwd: string,
): Promise<Result<Backend, CorpusError>> {
	// Check if it's a file path (contains /, starts with ., or is an existing dir)
	if (selector.includes("/") || selector.startsWith(".")) {
		const { create_file_backend } = await import("../../file.js");
		const backend = create_file_backend({ base_path: selector });
		return ok(backend);
	}

	// Check if it's an existing directory (Bun.file().type is safe to access)
	const file = Bun.file(selector);
	if (file.type === "directory") {
		const { create_file_backend } = await import("../../file.js");
		const backend = create_file_backend({ base_path: selector });
		return ok(backend);
	}

	// Otherwise treat as env name
	const wrangler_result = await sniff_wrangler(cwd);
	if (!wrangler_result.ok) return wrangler_result;

	const backend_result = await resolve_backend({ env: selector }, wrangler_result.value, {
		config,
		env_vars,
		cwd,
	});

	return backend_result;
}

export const clone_command: Command = {
	name: "clone",
	summary: "Clone snapshots from source to destination backend",
	spec: {
		positionals: ["source", "dest"],
		options: {
			store: { type: "string", multiple: true },
			tag: { type: "string", multiple: true },
			"dry-run": { type: "boolean" },
			concurrency: { type: "string" },
		},
	},
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		const source_selector = ctx.positionals[0];
		const dest_selector = ctx.positionals[1];

		if (!source_selector || !dest_selector) {
			return err({
				kind: "invalid_config",
				message: "clone requires <source> and <dest> arguments",
			});
		}

		// Check if dest is file backend (v1 restriction) — must be a file path
		if (!is_file_path(dest_selector)) {
			return err({
				kind: "invalid_config",
				message:
					"clone destination must be a file backend (v1). Remote/push operations are deferred to a future version.",
			});
		}

		// Load config
		const config_result = await load_cli_config(ctx.backend_selector.config);
		if (!config_result.ok) return config_result;

		// Resolve source backend
		const source_result = await resolve_selector(
			source_selector,
			ctx.backend_selector,
			config_result.value,
			ctx.env_vars,
			ctx.cwd,
		);
		if (!source_result.ok) return source_result;

		// Resolve dest backend
		const dest_result = await resolve_selector(
			dest_selector,
			ctx.backend_selector,
			config_result.value,
			ctx.env_vars,
			ctx.cwd,
		);
		if (!dest_result.ok) return dest_result;

		const source = source_result.value;
		const dest = dest_result.value;

		// Parse options
		const stores = (ctx.args.store as string[] | undefined) ?? [];
		const tags = (ctx.args.tag as string[] | undefined) ?? [];
		const dry_run = (ctx.args["dry-run"] as boolean | undefined) ?? false;
		const concurrency_str = (ctx.args.concurrency as string | undefined) ?? "4";

		const concurrency_result = await try_catch_async(
			() => Promise.resolve(parseInt(concurrency_str, 10)),
			(error): CorpusError => ({
				kind: "invalid_config",
				message: `invalid concurrency: ${error instanceof Error ? error.message : String(error)}`,
			}),
		);
		if (!concurrency_result.ok) return concurrency_result;

		const concurrency = concurrency_result.value;
		if (concurrency < 1 || !Number.isInteger(concurrency)) {
			return err({
				kind: "invalid_config",
				message: "concurrency must be a positive integer",
			});
		}

		// Prepare progress tracking
		let current_store = "";
		const spinner = ctx.output.spinner("Starting...");

		const on_progress = (event: CopyProgressEvent): void => {
			if (event.type === "store_start") {
				current_store = event.store_id;
				spinner.update(`${current_store}: 0 copied / 0 skipped`);
			} else if (event.type === "version_copied" || event.type === "version_skipped") {
				// Update spinner label with running count
				spinner.update(`${current_store}: versions`);
			} else if (event.type === "store_done") {
				const msg = `${event.store_id}: +${String(event.versions_copied)} copied, ${String(event.versions_skipped)} skipped`;
				ctx.output.note(msg);
			}
		};

		// Run copy
		const copy_result = await copy(source, dest, {
			stores: stores.length > 0 ? stores : undefined,
			tags: tags.length > 0 ? tags : undefined,
			dry_run,
			concurrency,
			on_progress,
		});

		spinner.stop();

		if (!copy_result.ok) return copy_result;

		const summary = copy_result.value;

		// Render output — render the summary as a table/lines
		// NOTE: In --json mode, this needs special handling to output CopySummary directly.
		// That requires passing the json flag through CommandContext, which is tracked in
		// the integration coder's report.
		const summary_rows = [
			{
				stores: String(summary.stores.length),
				versions_copied: String(summary.versions_copied),
				versions_skipped: String(summary.versions_skipped),
				data_objects: String(summary.data_objects_copied + summary.data_objects_skipped),
				bytes: String(summary.bytes_copied),
			},
		];

		ctx.output.table(summary_rows, ["stores", "versions_copied", "versions_skipped", "data_objects", "bytes"]);

		return ok(undefined);
	},
};

function is_file_path(selector: string): boolean {
	// A selector is a file path if it contains /, starts with ., or matches an existing directory
	if (selector.includes("/") || selector.startsWith(".")) {
		return true;
	}

	// Check if it's an existing directory (Bun.file().type is safe to access)
	const file = Bun.file(selector);
	return file.type === "directory";
}
