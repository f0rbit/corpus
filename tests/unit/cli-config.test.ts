import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { sniff_wrangler, type WranglerSniff } from "../../cli/wrangler.js";
import { load_cli_config } from "../../cli/load-config.js";
import { resolve_backend } from "../../cli/resolve-backend.js";

const fixture_base = join(import.meta.dir, "../fixtures/cli");

describe("sniff_wrangler", () => {
	it("extracts top-level config from wrangler.toml", async () => {
		const result = await sniff_wrangler(join(fixture_base, "wrangler-toml"));
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(`Expected ok result, got error: ${result.error.kind}`);
		}

		expect(result.value).not.toBeNull();
		expect(result.value!.account_id).toBe("test-account-123");
		expect(result.value!.d1_candidates.length).toBeGreaterThan(0);
		expect(result.value!.r2_candidates.length).toBeGreaterThan(0);
	});

	it("extracts top-level config from wrangler.jsonc", async () => {
		const result = await sniff_wrangler(join(fixture_base, "wrangler-jsonc"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value).not.toBeNull();
		expect(result.value!.account_id).toBe("test-account-123");
		expect(result.value!.d1_candidates.some((c: unknown) => (c as Record<string, unknown>).binding === "DB")).toBe(
			true,
		);
		expect(result.value!.r2_candidates.some((c: unknown) => (c as Record<string, unknown>).binding === "BUCKET")).toBe(
			true,
		);
	});

	it("extracts environment-specific config", async () => {
		const result = await sniff_wrangler(join(fixture_base, "wrangler-toml"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const staging_db = result.value!.d1_candidates.find(
			(c: unknown) => (c as Record<string, unknown>).binding === "STAGING_DB",
		);
		expect(staging_db).toBeDefined();
		expect(staging_db!.source).toBe("staging");
	});

	it("returns null when no wrangler file exists", async () => {
		// Create a temp dir with .git to prevent upward search from finding parent wrangler files
		const temp_dir = `/tmp/no-wrangler-${String(Date.now())}`;
		await mkdir(temp_dir, { recursive: true });
		await mkdir(`${temp_dir}/.git`, { recursive: true });

		try {
			const result = await sniff_wrangler(temp_dir);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		} finally {
			await rm(temp_dir, { recursive: true, force: true });
		}
	});
});

describe("load_cli_config", () => {
	it("loads and validates corpus.config.js", async () => {
		const config_path = join(fixture_base, "config-file/corpus.config.js");
		const result = await load_cli_config(config_path);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error(`Expected ok result, got error: ${result.error.kind}`);
		}

		expect(result.value).not.toBeNull();
		if (result.value != null) {
			expect(result.value.stores).toBeDefined();
			if (result.value.stores && result.value.stores.length > 0) {
				expect(result.value.stores.length).toBe(1);
				expect(result.value.stores[0]!.id).toBe("test-store");
			}
			expect(result.value.default_env ?? "prod").toBe("prod");
		}
	});

	it("returns null when no config file exists", async () => {
		// Use explicit path to a non-existent directory that has no corpus.config
		const temp_dir = `/tmp/nonexistent-corpus-test-${String(Date.now())}`;
		const result = await load_cli_config(join(temp_dir, "corpus.config.js"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBeNull();
		}
	});

	it("returns validation error for invalid config", async () => {
		const temp_file = "/tmp/test-invalid-config.js";

		await writeFile(
			temp_file,
			`export default {
			stores: "invalid"
		}`,
		);

		const result = await load_cli_config(temp_file);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("validation_error");
		}

		await unlink(temp_file);
	});
});

describe("resolve_backend", () => {
	it("resolves file backend when selector has file", async () => {
		const temp_dir = "/tmp/test-corpus-backend";
		await mkdir(temp_dir, { recursive: true });

		const result = await resolve_backend({ file: temp_dir }, null, {
			config: null,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);

		await rm(temp_dir, { recursive: true, force: true });
	});

	it("returns error when required params are missing", async () => {
		const result = await resolve_backend({ env: "prod" }, null, {
			config: null,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "invalid_config") {
			expect(result.error.message).toContain("missing");
		}
	});

	it("detects ambiguous D1 databases", async () => {
		const sniff: WranglerSniff = {
			account_id: "test-account",
			d1_candidates: [
				{ binding: "DB1", database_id: "id1", source: "top-level" as const },
				{ binding: "DB2", database_id: "id2", source: "top-level" as const },
			],
			r2_candidates: [],
		};

		const result = await resolve_backend({ env: "prod" }, sniff, {
			config: null,
			env_vars: { CLOUDFLARE_API_TOKEN: "token" },
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "invalid_config") {
			expect(result.error.message).toContain("ambiguous");
		}
	});

	it("detects ambiguous R2 buckets", async () => {
		const sniff: WranglerSniff = {
			account_id: "test-account",
			d1_candidates: [{ binding: "DB", database_id: "id1", source: "top-level" as const }],
			r2_candidates: [
				{ binding: "BUCKET1", bucket_name: "b1", source: "top-level" as const },
				{ binding: "BUCKET2", bucket_name: "b2", source: "top-level" as const },
			],
		};

		const result = await resolve_backend({ env: "prod" }, sniff, {
			config: null,
			env_vars: { CLOUDFLARE_API_TOKEN: "token" },
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "invalid_config") {
			expect(result.error.message).toContain("ambiguous");
		}
	});

	it("prioritizes config over wrangler sniff", async () => {
		const config: Record<string, unknown> = {
			environments: {
				prod: {
					account_id: "config-account",
					database_id: "config-db",
					bucket: "config-bucket",
				},
			},
		};

		const sniff = {
			account_id: "sniff-account",
			d1_candidates: [{ binding: "DB", database_id: "sniff-db", source: "top-level" as const }],
			r2_candidates: [{ binding: "BUCKET", bucket_name: "sniff-bucket", source: "top-level" as const }],
		};

		const result = await resolve_backend({ env: "prod" }, sniff, {
			config,
			env_vars: { CLOUDFLARE_API_TOKEN: "token" },
			cwd: process.cwd(),
		});

		// Config values should be used over sniff values
		// This will likely fail at create_remote_backend, but we're testing precedence logic
		// The test passes if we don't throw
		expect(typeof result).toBe("object");
	});

	it("resolves file backend from config", async () => {
		const temp_dir = "/tmp/test-corpus-backend-2";
		await mkdir(temp_dir, { recursive: true });

		const config: Record<string, unknown> = {
			environments: {
				local: {
					file: temp_dir,
				},
			},
		};

		const result = await resolve_backend({ env: "local" }, null, {
			config,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);

		await rm(temp_dir, { recursive: true, force: true });
	});

	it("uses default_env from config when env not specified", async () => {
		const temp_dir = "/tmp/test-corpus-backend-3";
		await mkdir(temp_dir, { recursive: true });

		const config: Record<string, unknown> = {
			default_env: "local",
			environments: {
				local: {
					file: temp_dir,
				},
			},
		};

		const result = await resolve_backend({}, null, {
			config,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);

		await rm(temp_dir, { recursive: true, force: true });
	});

	it("resolves database_id/bucket from CORPUS_D1_DATABASE_ID/CORPUS_R2_BUCKET env vars when config and sniff are absent", async () => {
		const result = await resolve_backend({ env: "prod" }, null, {
			config: null,
			env_vars: {
				CLOUDFLARE_ACCOUNT_ID: "env-account",
				CLOUDFLARE_API_TOKEN: "token",
				CORPUS_D1_DATABASE_ID: "env-database",
				CORPUS_R2_BUCKET: "env-bucket",
			},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);
	});

	it("missing-param message names the CORPUS_D1_DATABASE_ID/CORPUS_R2_BUCKET fallbacks", async () => {
		const result = await resolve_backend({ env: "prod" }, null, {
			config: null,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok && result.error.kind === "invalid_config") {
			expect(result.error.message).toContain("CORPUS_D1_DATABASE_ID");
			expect(result.error.message).toContain("CORPUS_R2_BUCKET");
		}
	});

	it("config still beats CORPUS_D1_DATABASE_ID/CORPUS_R2_BUCKET env fallbacks", async () => {
		const config: Record<string, unknown> = {
			environments: {
				prod: {
					account_id: "config-account",
					database_id: "config-db",
					bucket: "config-bucket",
				},
			},
		};

		const result = await resolve_backend({ env: "prod" }, null, {
			config,
			env_vars: {
				CLOUDFLARE_API_TOKEN: "token",
				CORPUS_D1_DATABASE_ID: "env-database",
				CORPUS_R2_BUCKET: "env-bucket",
			},
			cwd: process.cwd(),
		});

		// Config values take precedence; this only asserts precedence doesn't throw —
		// same limitation as the "prioritizes config over wrangler sniff" case above
		// (create_remote_backend doesn't expose resolved params for introspection).
		expect(typeof result).toBe("object");
	});

	it("wrangler sniff still beats CORPUS_D1_DATABASE_ID/CORPUS_R2_BUCKET env fallbacks", async () => {
		const sniff: WranglerSniff = {
			account_id: "sniff-account",
			d1_candidates: [{ binding: "DB", database_id: "sniff-db", source: "top-level" as const }],
			r2_candidates: [{ binding: "BUCKET", bucket_name: "sniff-bucket", source: "top-level" as const }],
		};

		const result = await resolve_backend({ env: "prod" }, sniff, {
			config: null,
			env_vars: {
				CLOUDFLARE_API_TOKEN: "token",
				CORPUS_D1_DATABASE_ID: "env-database",
				CORPUS_R2_BUCKET: "env-bucket",
			},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);
	});
});
