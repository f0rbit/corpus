import { type Result, ok } from "../types.js";
import { try_catch_async } from "../result.js";
import type { CorpusError } from "../types.js";
import type { CorpusCliConfig } from "./config-schema.js";
import { corpus_cli_config_schema } from "./config-schema.js";

async function find_upward(start_dir: string, filename: string): Promise<string | null> {
	let current = start_dir;

	while (true) {
		const candidate = `${current}/${filename}`;
		if (await Bun.file(candidate).exists()) {
			return candidate;
		}

		const git_dir = `${current}/.git`;
		if (await Bun.file(git_dir).exists()) {
			return null;
		}

		const parent = current.split("/").slice(0, -1).join("/");
		if (parent === current || parent === "") {
			return null;
		}
		current = parent;
	}
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

	const result = await try_catch_async(
		async () => {
			const imported = await import(config_path);
			const config_export = imported.default || imported.config || imported;

			const validated = corpus_cli_config_schema.safeParse(config_export);
			if (!validated.success) {
				throw new Error(`invalid corpus config at ${config_path}: ${validated.error.message}`);
			}

			return validated.data;
		},
		(error) => ({
			kind: "validation_error" as const,
			message: `failed to load config from ${config_path}: ${error instanceof Error ? error.message : String(error)}`,
			cause: error instanceof Error ? error : new Error(String(error)),
		}),
	);

	return result;
}
