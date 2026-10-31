/**
 * Guard for the REAL CLI parse pipeline: argv -> parse_global_args ->
 * backend_selector -> resolve_backend -> remote backend. Command tests call
 * `run(ctx)` directly and bypass all of this, which is how a selector
 * key-presence bug (`"file" in selector`) shipped unnoticed. These tests spawn
 * `bun cli/index.ts` against the in-process D1-HTTP and S3 fakes; the fake
 * endpoints reach the child via a throwaway `corpus.config.ts`
 * (`d1_base_url` / `r2_endpoint` — non-secret). Secrets go through env vars.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { create_remote_backend } from "../../backend/remote.js";
import { create_corpus, define_store, json_codec } from "../../index.js";
import { corpus_observations } from "../../observations/schema.js";
import { corpus_snapshots } from "../../schema.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";

const cli_path = join(import.meta.dir, "../../cli/index.ts");

const dry_run_summary_schema = z.object({
	dry_run: z.boolean(),
	versions_copied: z.number(),
	data_objects_copied: z.null(),
	data_objects_skipped: z.null(),
	bytes_copied: z.null(),
});

type Spawned = { code: number; stdout: string; stderr: string };

const database_uuid = "11111111-1111-4111-8111-111111111111";
const placeholder_wrangler = `account_id = "test-account"

[[d1_databases]]
binding = "DB"
database_name = "corpus"
database_id = "placeholder-will-be-set-by-sst"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "chamber-corpus"
`;

describe("CLI entrypoint — real argv pipeline against remote fakes", () => {
	let d1: FakeD1HttpServer;
	let s3: FakeS3Server;
	let work_dir: string;
	let version: string;

	const spawn_cli = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<Spawned> => {
		const merged: Record<string, string | undefined> = {
			...process.env,
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_API_TOKEN: "test-token",
			CORPUS_D1_DATABASE_ID: database_uuid,
			CORPUS_R2_BUCKET: "test-bucket",
			CORPUS_R2_ACCESS_KEY_ID: "test-access-key-id",
			CORPUS_R2_SECRET_ACCESS_KEY: "test-secret-access-key",
			...env,
		};
		const proc = Bun.spawn(["bun", cli_path, ...argv], {
			cwd: work_dir,
			env: Object.fromEntries(Object.entries(merged).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]]))),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	};

	beforeEach(async () => {
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations], {
			api_token: "test-token",
			database_id: database_uuid,
		});
		s3 = create_fake_s3();
		work_dir = await mkdtemp(join(tmpdir(), "corpus-cli-entry-"));

		await writeFile(
			join(work_dir, "corpus.config.ts"),
			`export default { default_env: "fake", environments: { fake: { d1_base_url: ${JSON.stringify(d1.url)}, r2_endpoint: ${JSON.stringify(s3.url)} } } };\n`,
		);

		const backend = create_remote_backend({
			account_id: "test-account",
			database_id: database_uuid,
			api_token: "test-token",
			d1_base_url: d1.url,
			r2: {
				bucket: "test-bucket",
				access_key_id: "test-access-key-id",
				secret_access_key: "test-secret-access-key",
				endpoint: s3.url,
			},
		});
		const corpus = create_corpus()
			.with_backend(backend)
			.with_store(define_store("items", json_codec(z.object({ id: z.string() }))))
			.build();
		const put = await corpus.stores.items.put({ id: "a" });
		if (!put.ok) throw new Error("seed failed");
		version = put.value.version;
	});

	afterEach(async () => {
		d1.stop();
		s3.stop();
		await rm(work_dir, { recursive: true, force: true });
	});

	it("stores --json reaches the remote backend (no file selector leak)", async () => {
		const result = await spawn_cli(["stores", "--json"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("items");
		expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
	});

	it("versions --json lists the seeded version", async () => {
		const result = await spawn_cli(["versions", "items", "--json"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(version);
	});

	it("clone --dry-run --json emits null data counts and dry_run: true", async () => {
		const dest = join(work_dir, "clone-dest");
		const result = await spawn_cli(["clone", "fake", dest, "--dry-run", "--json"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const summary = dry_run_summary_schema.parse(JSON.parse(result.stdout));
		expect(summary).toEqual({
			dry_run: true,
			versions_copied: 1,
			data_objects_copied: null,
			data_objects_skipped: null,
			bytes_copied: null,
		});
	});

	it("a failing command writes to stderr and exits 1 (never silent)", async () => {
		const result = await spawn_cli(["stores"], { CLOUDFLARE_API_TOKEN: undefined });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("CLOUDFLARE_API_TOKEN");
		expect(result.stderr).not.toContain("test-secret-access-key");
	});

	describe("listing failures are never an empty database", () => {
		it("a bad token fails `stores` with the root cause on stderr and nothing on stdout", async () => {
			const result = await spawn_cli(["stores"], { CLOUDFLARE_API_TOKEN: "wrong-token" });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("error:");
			expect(result.stderr).toContain("401");
			expect(result.stderr).not.toContain("wrong-token");
		});

		it("a bad token fails `versions <store>` the same way", async () => {
			const result = await spawn_cli(["versions", "items"], { CLOUDFLARE_API_TOKEN: "wrong-token" });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("error:");
			expect(result.stderr).toContain("401");
		});

		it("a wrong database id fails instead of listing nothing", async () => {
			const result = await spawn_cli(["stores"], { CORPUS_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222" });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("404");
		});

		it("a bad token fails `clone` instead of reporting an empty successful copy", async () => {
			const dest = join(work_dir, "clone-bad-token");
			const result = await spawn_cli(["clone", "fake", dest], { CLOUDFLARE_API_TOKEN: "wrong-token" });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("error:");
			expect(result.stderr).toContain("401");
		});

		it("a bad token fails `clone --dry-run` too", async () => {
			const dest = join(work_dir, "clone-bad-token-dry");
			const result = await spawn_cli(["clone", "fake", dest, "--dry-run"], { CLOUDFLARE_API_TOKEN: "wrong-token" });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("error:");
			expect(result.stderr).toContain("401");
		});

		it("--json errors are one { error: { kind, message } } document on stdout with exit 1", async () => {
			const result = await spawn_cli(["stores", "--json"], { CLOUDFLARE_API_TOKEN: "wrong-token" });
			expect(result.code).toBe(1);
			const doc = z
				.object({ error: z.object({ kind: z.string(), message: z.string() }) })
				.parse(JSON.parse(result.stdout));
			expect(doc.error.kind).toBe("storage_error");
			expect(doc.error.message.startsWith("error:")).toBe(false);
		});
	});

	describe("database_id precedence against a placeholder wrangler.toml", () => {
		beforeEach(async () => {
			await writeFile(join(work_dir, "wrangler.toml"), placeholder_wrangler);
		});

		it("CORPUS_D1_DATABASE_ID beats the placeholder and lists stores", async () => {
			const result = await spawn_cli(["stores", "--json"]);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("items");
		});

		it("without the env var, the placeholder is an error naming the fix", async () => {
			const result = await spawn_cli(["stores"], { CORPUS_D1_DATABASE_ID: undefined });
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("placeholder-will-be-set-by-sst");
			expect(result.stderr).toContain("CORPUS_D1_DATABASE_ID");
			expect(result.stderr).toContain("wrangler.toml");
		});
	});

	describe("--tag with --limit", () => {
		it("returns the requested count of tagged versions even when the newest are untagged", async () => {
			const backend = create_remote_backend({
				account_id: "test-account",
				database_id: database_uuid,
				api_token: "test-token",
				d1_base_url: d1.url,
				r2: {
					bucket: "test-bucket",
					access_key_id: "test-access-key-id",
					secret_access_key: "test-secret-access-key",
					endpoint: s3.url,
				},
			});
			const corpus = create_corpus()
				.with_backend(backend)
				.with_store(define_store("tagged", json_codec(z.object({ n: z.number() }))))
				.build();
			for (const n of [1, 2, 3, 4, 5, 6]) {
				const put = await corpus.stores.tagged.put({ n }, n <= 3 ? { tags: ["chamber:house"] } : {});
				if (!put.ok) throw new Error("seed failed");
				await Bun.sleep(5);
			}

			const result = await spawn_cli(["versions", "tagged", "--tag", "chamber:house", "--limit", "2", "--json"]);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			const doc = z.object({ versions: z.array(z.object({ version: z.string() })) }).parse(JSON.parse(result.stdout));
			expect(doc.versions).toHaveLength(2);
		});
	});

	describe("missing stores", () => {
		it("`versions no-such-store` fails with a store-level message", async () => {
			const result = await spawn_cli(["versions", "no-such-store"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('error: store "no-such-store" not found (no versions)');
		});

		it("`show no-such-store latest` fails the same way", async () => {
			const result = await spawn_cli(["show", "no-such-store", "latest"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('store "no-such-store" not found');
		});

		it("`show items latest` resolves via get_latest", async () => {
			const result = await spawn_cli(["show", "items", "latest", "--json"]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(version);
		});
	});
});
