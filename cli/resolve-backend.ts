import type { Backend } from "../types.js";
import { type Result, err, ok } from "../types.js";
import type { CorpusError } from "../types.js";
import type { CorpusCliConfig } from "./config-schema.js";
import type { WranglerSniff } from "./wrangler.js";

export type BackendSelector = { env?: string } | { file: string };

export type ResolveBackendContext = {
	config: CorpusCliConfig | null;
	env_vars: Record<string, string | undefined>;
	cwd: string;
};

export async function resolve_backend(
	selector: BackendSelector,
	wrangler_sniff: WranglerSniff | null,
	ctx: ResolveBackendContext,
): Promise<Result<Backend, CorpusError>> {
	// Handle file backend selector
	if ("file" in selector) {
		const { create_file_backend } = await import("../file.js");
		const backend = create_file_backend({ base_path: selector.file });
		return ok(backend);
	}

	// Determine which environment to use
	const env_name = selector.env || ctx.config?.default_env || "remote";

	// Get environment config from corpus.config.ts
	const env_config = ctx.config?.environments?.[env_name];

	// Handle file backend from config
	if (env_config && "file" in env_config) {
		const { create_file_backend } = await import("../file.js");
		const backend = create_file_backend({ base_path: env_config.file });
		return ok(backend);
	}

	// Check for ambiguities first, before trying to resolve
	if (
		wrangler_sniff &&
		wrangler_sniff.d1_candidates.length > 1 &&
		!(env_config && "database_id" in env_config && env_config.database_id)
	) {
		return err({
			kind: "invalid_config",
			message: `ambiguous D1 database: found ${String(wrangler_sniff.d1_candidates.length)} candidates (${wrangler_sniff.d1_candidates.map((c) => `${c.binding} (${c.source})`).join(", ")}). Set database_id in corpus.config.ts.`,
			cause: new Error("ambiguous database"),
		});
	}

	if (
		wrangler_sniff &&
		wrangler_sniff.r2_candidates.length > 1 &&
		!(env_config && "bucket" in env_config && env_config.bucket)
	) {
		return err({
			kind: "invalid_config",
			message: `ambiguous R2 bucket: found ${String(wrangler_sniff.r2_candidates.length)} candidates (${wrangler_sniff.r2_candidates.map((c) => `${c.binding} (${c.source})`).join(", ")}). Set bucket in corpus.config.ts.`,
			cause: new Error("ambiguous bucket"),
		});
	}

	// For remote backend, resolve connection parameters with precedence:
	// config file > wrangler sniff > env vars
	const account_id =
		(env_config && "account_id" in env_config ? env_config.account_id : undefined) ||
		wrangler_sniff?.account_id ||
		ctx.env_vars.CLOUDFLARE_ACCOUNT_ID;

	// Lowest-precedence fallback: config > wrangler sniff > env. Closes the
	// placeholder-wrangler gap for consumers whose checked-in wrangler.toml
	// carries IaC-templated ids (e.g. SST) that sniff can't resolve.
	const database_id =
		(env_config && "database_id" in env_config ? env_config.database_id : undefined) ||
		wrangler_sniff?.d1_candidates[0]?.database_id ||
		ctx.env_vars.CORPUS_D1_DATABASE_ID;

	const bucket =
		(env_config && "bucket" in env_config ? env_config.bucket : undefined) ||
		wrangler_sniff?.r2_candidates[0]?.bucket_name ||
		ctx.env_vars.CORPUS_R2_BUCKET;

	const d1_base_url = env_config && "d1_base_url" in env_config ? env_config.d1_base_url : undefined;

	const r2_endpoint = env_config && "r2_endpoint" in env_config ? env_config.r2_endpoint : undefined;

	const api_token = ctx.env_vars.CLOUDFLARE_API_TOKEN;
	const access_key_id = ctx.env_vars.CORPUS_R2_ACCESS_KEY_ID;
	const secret_access_key = ctx.env_vars.CORPUS_R2_SECRET_ACCESS_KEY;

	// Collect missing required parameters
	const missing: string[] = [];

	if (!account_id) missing.push("account_id (via CLOUDFLARE_ACCOUNT_ID env or config)");
	if (!database_id) {
		missing.push("database_id (via corpus.config.ts, wrangler.toml, or CORPUS_D1_DATABASE_ID env)");
	}

	if (!bucket) {
		missing.push("bucket (via corpus.config.ts, wrangler.toml, or CORPUS_R2_BUCKET env)");
	}

	if (!api_token) missing.push("CLOUDFLARE_API_TOKEN env var");

	if (missing.length > 0) {
		return err({
			kind: "invalid_config",
			message: `cannot resolve remote backend: missing ${missing.join(", ")}`,
			cause: new Error("missing config"),
		});
	}

	// Create remote backend
	const { create_remote_backend } = await import("../remote.js");

	// Type narrowing: if we reach here, all required params must be defined
	if (!account_id || !database_id || !api_token || !bucket) {
		return err({
			kind: "invalid_config",
			message: "configuration error: required params missing",
			cause: new Error("missing required config"),
		});
	}

	const remote_config = {
		account_id,
		database_id,
		api_token,
		r2: {
			bucket,
			access_key_id: access_key_id || "",
			secret_access_key: secret_access_key || "",
			...(r2_endpoint && { endpoint: r2_endpoint }),
		},
		...(d1_base_url && { d1_base_url }),
	};

	const backend = create_remote_backend(remote_config);
	return ok(backend);
}
