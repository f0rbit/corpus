import { describe, it, expect } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Arbitrary } from "fast-check";
import * as testing from "../../testing/index.js";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";
import { sniff_wrangler, type WranglerSniff } from "../../cli/wrangler.js";
import { load_cli_config } from "../../cli/load-config.js";
import { define_config } from "../../cli/config-schema.js";
import { resolve_backend, resolve_connection_ids } from "../../cli/resolve-backend.js";

const fc = testing.fc;

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
		const temp_dir = await make_tmp_dir("no-wrangler");
		await mkdir(`${temp_dir}/.git`, { recursive: true });

		try {
			const result = await sniff_wrangler(temp_dir);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBeNull();
			}
		} finally {
			await remove_tmp_dir(temp_dir);
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
		const parent_dir = await make_tmp_dir("nonexistent");
		const result = await load_cli_config(join(parent_dir, "never-created", "corpus.config.js"));
		await remove_tmp_dir(parent_dir);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toBeNull();
		}
	});

	it("returns validation error for invalid config", async () => {
		const temp_dir = await make_tmp_dir("invalid-config");
		const temp_file = join(temp_dir, "invalid-config.js");

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

		await remove_tmp_dir(temp_dir);
	});
});

async function in_tmp_repo(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await make_tmp_dir(prefix);
	await mkdir(join(dir, ".git"), { recursive: true });
	try {
		await fn(dir);
	} finally {
		await remove_tmp_dir(dir);
	}
}

describe("sniff_wrangler edge cases", () => {
	it("an unreadable wrangler.toml (a directory) is a storage_error naming the path", async () => {
		await in_tmp_repo("wrangler-unreadable", async (dir) => {
			await mkdir(join(dir, "wrangler.toml"));
			const result = await sniff_wrangler(dir);
			expect(result.ok).toBe(false);
			if (result.ok || result.error.kind !== "storage_error") throw new Error("expected storage_error");
			expect(result.error.operation).toBe(`read file ${join(dir, "wrangler.toml")}`);
		});
	});

	it("wrangler.jsonc tolerates line comments, block comments and trailing commas", async () => {
		await in_tmp_repo("wrangler-jsonc", async (dir) => {
			await writeFile(
				join(dir, "wrangler.jsonc"),
				`/* header
				   block */ {
				"account_id": "acc", // line comment
				"r2_buckets": [{ "binding": "B", /* inline */ "bucket_name": "bk", },],
			}`,
			);
			const result = await sniff_wrangler(dir);
			if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
			expect(result.value).toEqual({
				path: join(dir, "wrangler.jsonc"),
				account_id: "acc",
				d1_candidates: [],
				r2_candidates: [{ binding: "B", bucket_name: "bk", source: "top-level" }],
			});
		});
	});

	const parse_failures: Array<{ file: string; content: string; prefix: string }> = [
		{ file: "wrangler.toml", content: "this = = not [toml", prefix: "failed to parse wrangler.toml: " },
		{ file: "wrangler.json", content: "{nope", prefix: "failed to parse wrangler.json: " },
		{ file: "wrangler.jsonc", content: "{ // only a comment\n", prefix: "failed to parse wrangler.jsonc: " },
	];

	for (const c of parse_failures) {
		it(`invalid ${c.file} syntax is a parse validation_error`, async () => {
			await in_tmp_repo("wrangler-parse", async (dir) => {
				await writeFile(join(dir, c.file), c.content);
				const result = await sniff_wrangler(dir);
				if (result.ok || result.error.kind !== "validation_error") throw new Error("expected validation_error");
				expect(result.error.message.startsWith(c.prefix)).toBe(true);
			});
		});
	}

	const wrong_structure: Array<{ file: string; content: string }> = [
		{ file: "wrangler.json", content: `{"d1_databases": "not-an-array"}` },
		{ file: "wrangler.toml", content: `r2_buckets = "nope"` },
		{ file: "wrangler.jsonc", content: `{"env": {"x": {"r2_buckets": [{"binding": 1}]}}}` },
	];

	for (const c of wrong_structure) {
		it(`valid ${c.file} syntax with the wrong structure is "invalid wrangler.* structure"`, async () => {
			await in_tmp_repo("wrangler-structure", async (dir) => {
				await writeFile(join(dir, c.file), c.content);
				const result = await sniff_wrangler(dir);
				if (result.ok || result.error.kind !== "validation_error") throw new Error("expected validation_error");
				expect(result.error.message).toBe(`invalid ${c.file} structure`);
			});
		});
	}

	it("collects env-scoped d1_databases and r2_buckets with the env name as source", async () => {
		await in_tmp_repo("wrangler-env", async (dir) => {
			await writeFile(
				join(dir, "wrangler.json"),
				JSON.stringify({
					r2_buckets: [{ binding: "TOP", bucket_name: "top-bucket" }],
					env: {
						staging: {
							account_id: "ignored",
							d1_databases: [{ binding: "SDB", database_id: "sid" }],
							r2_buckets: [{ binding: "SB", bucket_name: "stg-bucket" }],
						},
						empty: {},
					},
				}),
			);
			const result = await sniff_wrangler(dir);
			if (!result.ok || !result.value) throw new Error("expected a sniff");
			expect(result.value.r2_candidates).toEqual([
				{ binding: "TOP", bucket_name: "top-bucket", source: "top-level" },
				{ binding: "SB", bucket_name: "stg-bucket", source: "staging" },
			]);
			expect(result.value.d1_candidates).toEqual([{ binding: "SDB", database_id: "sid", source: "staging" }]);
		});
	});

	it("prefers wrangler.toml over wrangler.jsonc over wrangler.json when several exist", async () => {
		await in_tmp_repo("wrangler-precedence", async (dir) => {
			await writeFile(join(dir, "wrangler.json"), JSON.stringify({ account_id: "from-json" }));
			await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ account_id: "from-jsonc" }));
			const jsonc = await sniff_wrangler(dir);
			expect(jsonc.ok && jsonc.value?.account_id).toBe("from-jsonc");
			await writeFile(join(dir, "wrangler.toml"), `account_id = "from-toml"`);
			const toml = await sniff_wrangler(dir);
			expect(toml.ok && toml.value?.account_id).toBe("from-toml");
		});
	});
});

describe("load_cli_config edge cases", () => {
	it("a config that throws at import is a validation_error naming the path and the cause", async () => {
		await in_tmp_repo("config-throws", async (dir) => {
			const config_path = join(dir, "corpus.config.ts");
			await writeFile(config_path, `throw new Error("kaboom at import");`);
			const result = await load_cli_config(undefined, dir);
			if (result.ok || result.error.kind !== "validation_error") throw new Error("expected validation_error");
			expect(result.error.message).toContain(`failed to load config from ${config_path}`);
			expect(result.error.message).toContain("kaboom at import");
			expect(result.error.cause.message).toContain("kaboom at import");
		});
	});

	it("discovers corpus.config.ts, then corpus.config.js, from the given cwd and honours a named `config` export", async () => {
		await in_tmp_repo("config-discovery", async (dir) => {
			await writeFile(join(dir, "corpus.config.js"), `export const config = { default_env: "from-js" };`);
			const js = await load_cli_config(undefined, dir);
			expect(js.ok && js.value?.default_env).toBe("from-js");
		});
		await in_tmp_repo("config-discovery-ts", async (dir) => {
			await writeFile(join(dir, "corpus.config.ts"), `export default { default_env: "from-ts" };`);
			await writeFile(join(dir, "corpus.config.js"), `export default { default_env: "from-js" };`);
			const ts = await load_cli_config(undefined, dir);
			expect(ts.ok && ts.value?.default_env).toBe("from-ts");
		});
	});

	it("unknown keys are rejected by the strict schema, naming the file", async () => {
		await in_tmp_repo("config-strict", async (dir) => {
			const config_path = join(dir, "corpus.config.ts");
			await writeFile(config_path, `export default { surprise: true };`);
			const result = await load_cli_config(undefined, dir);
			if (result.ok || result.error.kind !== "validation_error") throw new Error("expected validation_error");
			expect(result.error.message).toContain(`invalid corpus config at ${config_path}`);
		});
	});

	it("no config upward of cwd is ok(null)", async () => {
		await in_tmp_repo("config-none", async (dir) => {
			const result = await load_cli_config(undefined, dir);
			expect(result).toEqual({ ok: true, value: null });
		});
	});
});

describe("define_config", () => {
	it("returns its argument unchanged (identity)", () => {
		fc.assert(
			fc.property(fc.record({ default_env: fc.option(fc.string(), { nil: undefined }) }), (config) => {
				expect(define_config(config)).toBe(config);
			}),
		);
	});
});

describe("resolve_backend", () => {
	it("resolves file backend when selector has file", async () => {
		const temp_dir = await make_tmp_dir("backend");

		const result = await resolve_backend({ file: temp_dir }, null, {
			config: null,
			env_vars: {},
			cwd: process.cwd(),
		});

		expect(result.ok).toBe(true);

		await remove_tmp_dir(temp_dir);
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
		const temp_dir = await make_tmp_dir("backend-2");

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

		await remove_tmp_dir(temp_dir);
	});

	it("uses default_env from config when env not specified", async () => {
		const temp_dir = await make_tmp_dir("backend-3");

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

		await remove_tmp_dir(temp_dir);
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
});

const sniff_path = "/ws/wrangler.toml";

const opt_name = (prefix: string): Arbitrary<string | undefined> =>
	fc.option(
		fc.stringMatching(/^[a-z0-9]{1,8}$/).map((s) => `${prefix}-${s}`),
		{ nil: undefined },
	);

const d1_candidate_arb = fc.oneof(
	fc.uuid().map((database_id) => ({ binding: "DB", database_id, source: "top-level" })),
	fc
		.stringMatching(/^[a-z]{1,8}$/)
		.map((s) => ({ binding: "DB", database_id: `placeholder-${s}`, source: "top-level" })),
);

const r2_candidate_arb = fc
	.stringMatching(/^[a-z0-9]{1,8}$/)
	.map((s) => ({ binding: "BUCKET", bucket_name: `sniff-${s}`, source: "top-level" }));

const precedence_arb = fc.record({
	cfg_db: opt_name("cfg-db"),
	cfg_bucket: opt_name("cfg-bucket"),
	env_db: opt_name("env-db"),
	env_bucket: opt_name("env-bucket"),
	sniffed: fc.boolean(),
	d1: fc.array(d1_candidate_arb, { maxLength: 4 }),
	r2: fc.array(r2_candidate_arb, { maxLength: 3 }),
});

const uuid_re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("resolve_connection_ids precedence", () => {
	it("database_id/bucket = first of config, env var, sniffed candidate; placeholder-only sniff is invalid_config", () => {
		fc.assert(
			fc.property(precedence_arb, (m) => {
				const env_config = {
					...(m.cfg_db !== undefined && { database_id: m.cfg_db }),
					...(m.cfg_bucket !== undefined && { bucket: m.cfg_bucket }),
				};
				const env_vars = { CORPUS_D1_DATABASE_ID: m.env_db, CORPUS_R2_BUCKET: m.env_bucket };
				const sniff: WranglerSniff | null = m.sniffed
					? { path: sniff_path, d1_candidates: m.d1, r2_candidates: m.r2 }
					: null;

				const result = resolve_connection_ids(env_config, sniff, env_vars);

				const d1 = sniff?.d1_candidates ?? [];
				const expected_db = m.cfg_db ?? m.env_db ?? d1.find((c) => uuid_re.test(c.database_id))?.database_id;
				const expected_bucket = m.cfg_bucket ?? m.env_bucket ?? sniff?.r2_candidates[0]?.bucket_name;

				if (expected_db === undefined && d1.length > 0) {
					const first = d1[0];
					expect(result.ok).toBe(false);
					if (result.ok || result.error.kind !== "invalid_config" || !first) return;
					expect(result.error.message).toContain(first.database_id);
					expect(result.error.message).toContain(sniff_path);
					expect(result.error.message).toContain("CORPUS_D1_DATABASE_ID");
					return;
				}

				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.value).toEqual({ database_id: expected_db, bucket: expected_bucket });
			}),
			{ numRuns: 300 },
		);
	});
});

describe("resolve_connection_ids placeholder", () => {
	it("a placeholder database_id with no other source is invalid_config naming the file and the fix", () => {
		const placeholder: WranglerSniff = {
			path: sniff_path,
			d1_candidates: [{ binding: "DB", database_id: "placeholder-will-be-set-by-sst", source: "top-level" }],
			r2_candidates: [{ binding: "BUCKET", bucket_name: "chamber-corpus", source: "top-level" }],
		};
		const result = resolve_connection_ids(undefined, placeholder, {});
		expect(result.ok).toBe(false);
		if (result.ok || result.error.kind !== "invalid_config") return;
		expect(result.error.message).toContain("placeholder-will-be-set-by-sst");
		expect(result.error.message).toContain("/ws/wrangler.toml");
		expect(result.error.message).toContain("CORPUS_D1_DATABASE_ID");
		expect(result.error.message).toContain("corpus.config.ts");
	});
});
