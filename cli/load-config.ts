import { type Result, err, ok } from "../types.js";
import { try_catch_async } from "../result.js";
import type { CorpusError } from "../types.js";
import type { CorpusCliConfig } from "./config-schema.js";
import { corpus_cli_config_schema } from "./config-schema.js";
import { find_upward } from "./fs-walk.js";

function config_export_of(imported: unknown): unknown {
	if (typeof imported !== "object" || imported === null) return imported;
	const mod = imported as Record<string, unknown>;
	return mod.default ?? mod.config ?? imported;
}

export async function load_cli_config(explicit_path?: string): Promise<Result<CorpusCliConfig | null, CorpusError>> {
	let config_path: string | null;

	if (explicit_path) {
		// Check if explicit path exists
		if (!(await Bun.file(explicit_path).exists())) {
			return ok(null);
		}
		config_path = explicit_path;
	} else {
		config_path =
			(await find_upward(process.cwd(), "corpus.config.ts")) || (await find_upward(process.cwd(), "corpus.config.js"));
	}

	if (!config_path) {
		return ok(null);
	}

	const import_result = await try_catch_async(
		(): Promise<unknown> => import(config_path),
		(error): CorpusError => ({
			kind: "validation_error",
			message: `failed to load config from ${config_path}: ${error instanceof Error ? error.message : String(error)}`,
			cause: error instanceof Error ? error : new Error(String(error)),
		}),
	);
	if (!import_result.ok) return import_result;

	const validated = corpus_cli_config_schema.safeParse(config_export_of(import_result.value));
	if (!validated.success) {
		return err({
			kind: "validation_error",
			message: `invalid corpus config at ${config_path}: ${validated.error.message}`,
			cause: new Error(validated.error.message),
		});
	}

	return ok(validated.data);
}
