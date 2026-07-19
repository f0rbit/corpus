import { type Result, err, ok } from "../types.js";
import { try_catch_async } from "../result.js";
import type { CorpusError } from "../types.js";
import { z } from "zod";

export type WranglerSniff = {
	account_id?: string;
	d1_candidates: Array<{ binding: string; database_id: string; source: "top-level" | string }>;
	r2_candidates: Array<{ binding: string; bucket_name: string; source: "top-level" | string }>;
};

const d1_binding_schema = z.object({
	binding: z.string(),
	database_id: z.string(),
});

const r2_binding_schema = z.object({
	binding: z.string(),
	bucket_name: z.string(),
});

const wrangler_file_schema = z.object({
	account_id: z.string().optional(),
	d1_databases: z.array(d1_binding_schema).optional(),
	r2_buckets: z.array(r2_binding_schema).optional(),
	env: z
		.record(
			z.object({
				account_id: z.string().optional(),
				d1_databases: z.array(d1_binding_schema).optional(),
				r2_buckets: z.array(r2_binding_schema).optional(),
			}),
		)
		.optional(),
});

async function read_file(path: string): Promise<Result<string, CorpusError>> {
	return try_catch_async(
		async () => {
			const file = Bun.file(path);
			return await file.text();
		},
		(error) => ({
			kind: "storage_error" as const,
			operation: `read file ${path}`,
			cause: error instanceof Error ? error : new Error(String(error)),
		}),
	);
}

function strip_jsonc(content: string): string {
	let result = "";
	let i = 0;
	while (i < content.length) {
		if (content[i] === "/" && content[i + 1] === "/") {
			// Line comment - skip to end of line but preserve newline
			while (i < content.length && content[i] !== "\n") i++;
			// Don't increment i here - we want the newline to be processed next iteration
		} else if (content[i] === "/" && content[i + 1] === "*") {
			// Block comment
			i += 2;
			while (i < content.length - 1) {
				if (content[i] === "*" && content[i + 1] === "/") {
					i += 2;
					break;
				}
				i++;
			}
		} else if (content[i] === ",") {
			// Check if this is a trailing comma (comma followed by whitespace and then } or ])
			let j = i + 1;
			const c = j < content.length ? content[j]! : "";
			if (c && /\s/.test(c)) {
				while (j < content.length && /\s/.test(content[j]!)) {
					j++;
				}
			}
			if (j < content.length && (content[j] === "}" || content[j] === "]")) {
				// This is a trailing comma, skip it
				i++;
			} else {
				// Not a trailing comma, keep it
				result += content[i];
				i++;
			}
		} else {
			result += content[i];
			i++;
		}
	}
	return result;
}

async function try_parse_wrangler(
	content: string,
	format: "toml" | "jsonc" | "json",
): Promise<Result<Record<string, unknown>, CorpusError>> {
	return try_catch_async(
		async () => {
			let parsed: unknown;

			if (format === "toml") {
				parsed = Bun.TOML.parse(content);
			} else {
				const cleaned = format === "jsonc" ? strip_jsonc(content) : content;
				parsed = JSON.parse(cleaned);
			}

			return parsed as Record<string, unknown>;
		},
		(error) => ({
			kind: "validation_error" as const,
			message: `failed to parse wrangler.${format}: ${error instanceof Error ? error.message : String(error)}`,
			cause: error instanceof Error ? error : new Error(String(error)),
		}),
	);
}

async function sniff_from_content(
	content: string,
	format: "toml" | "jsonc" | "json",
): Promise<Result<WranglerSniff, CorpusError>> {
	const parsed_result = await try_parse_wrangler(content, format);
	if (!parsed_result.ok) return parsed_result;

	const parsed = parsed_result.value;
	const validated = wrangler_file_schema.safeParse(parsed);
	if (!validated.success) {
		return err({
			kind: "validation_error" as const,
			message: `invalid wrangler.${format} structure`,
			cause: new Error(validated.error.message),
		});
	}

	const data = validated.data;

	const d1_candidates: WranglerSniff["d1_candidates"] = [];
	const r2_candidates: WranglerSniff["r2_candidates"] = [];

	if (data.d1_databases) {
		for (const db of data.d1_databases) {
			d1_candidates.push({
				binding: db.binding,
				database_id: db.database_id,
				source: "top-level",
			});
		}
	}

	if (data.r2_buckets) {
		for (const bucket of data.r2_buckets) {
			r2_candidates.push({
				binding: bucket.binding,
				bucket_name: bucket.bucket_name,
				source: "top-level",
			});
		}
	}

	if (data.env) {
		for (const [env_name, env_config] of Object.entries(data.env)) {
			if (env_config.d1_databases) {
				for (const db of env_config.d1_databases) {
					d1_candidates.push({
						binding: db.binding,
						database_id: db.database_id,
						source: env_name,
					});
				}
			}
			if (env_config.r2_buckets) {
				for (const bucket of env_config.r2_buckets) {
					r2_candidates.push({
						binding: bucket.binding,
						bucket_name: bucket.bucket_name,
						source: env_name,
					});
				}
			}
		}
	}

	return ok({
		account_id: data.account_id,
		d1_candidates,
		r2_candidates,
	});
}

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

export async function sniff_wrangler(dir: string): Promise<Result<WranglerSniff | null, CorpusError>> {
	const toml_path = await find_upward(dir, "wrangler.toml");
	const jsonc_path = await find_upward(dir, "wrangler.jsonc");
	const json_path = await find_upward(dir, "wrangler.json");

	const wrangler_path = toml_path || jsonc_path || json_path;

	if (!wrangler_path) {
		return ok(null);
	}

	const format = wrangler_path.endsWith(".toml") ? "toml" : wrangler_path.endsWith(".jsonc") ? "jsonc" : "json";

	const content_result = await read_file(wrangler_path);
	if (!content_result.ok) return content_result;

	return sniff_from_content(content_result.value, format);
}
