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
			CORPUS_D1_DATABASE_ID: "test-database",
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
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3 = create_fake_s3();
		work_dir = await mkdtemp(join(tmpdir(), "corpus-cli-entry-"));

		await writeFile(
			join(work_dir, "corpus.config.ts"),
			`export default { default_env: "fake", environments: { fake: { d1_base_url: ${JSON.stringify(d1.url)}, r2_endpoint: ${JSON.stringify(s3.url)} } } };\n`,
		);

		const backend = create_remote_backend({
			account_id: "test-account",
			database_id: "test-database",
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
});
