import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { z } from "zod";
import { parse_global_args } from "../../cli/args.js";
import { build_backend_selector, run_cli, type CliIo } from "../../cli/main.js";
import { resolve_backend, type BackendSelector } from "../../cli/resolve-backend.js";
import { write_fatal } from "../../cli/output.js";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";

const error_doc_schema = z.object({ error: z.object({ kind: z.string(), message: z.string() }) });

type Run = { code: number; stdout: string; stderr: string };

const run = async (argv: string[], over: Partial<CliIo> = {}): Promise<Run> => {
	const out: string[] = [];
	const errs: string[] = [];
	const code = await run_cli({
		argv,
		env: {},
		cwd: import.meta.dir,
		stdout_is_tty: false,
		stderr_is_tty: false,
		stdout_write: (chunk) => {
			out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		},
		stderr_write: (chunk) => {
			errs.push(chunk);
		},
		...over,
	});
	return { code, stdout: out.join(""), stderr: errs.join("") };
};

// A throwing stdout sink is the one reachable non-Result failure path
// without a test-only hook (load_cli_config / commands all return Results).
const throwing_stdout = (): void => {
	throw new Error("sink exploded");
};

describe("build_backend_selector", () => {
	it("never emits a key with an undefined value, and emits `file` exactly when given", () => {
		const opt = fc.option(fc.string(), { nil: undefined });
		fc.assert(
			fc.property(fc.record({ env: opt, file: opt, config: opt }), (given) => {
				const sel = build_backend_selector({ ...given, json: false, quiet: false, help: false, positionals: [] });
				expect(Object.values(sel).every((v) => typeof v === "string")).toBe(true);
				expect("file" in sel).toBe(given.file !== undefined);
				expect("env" in sel).toBe(given.env !== undefined);
				expect("config" in sel).toBe(given.config !== undefined);
			}),
		);
	});

	it("is what parse_global_args feeds: no --file means no file key", () => {
		const sel = build_backend_selector(parse_global_args(["stores", "--env", "remote"]));
		expect(sel).toEqual({ env: "remote" });
	});
});

describe("resolve_backend selector key presence", () => {
	it("{ file: undefined } takes the remote path, not a file backend", async () => {
		const selector: BackendSelector = { file: undefined, env: "remote" };
		const result = await resolve_backend(selector, null, {
			config: null,
			cwd: import.meta.dir,
			env_vars: {
				CLOUDFLARE_ACCOUNT_ID: "acct",
				CORPUS_D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
				CORPUS_R2_BUCKET: "bucket",
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid_config");
		expect(result.error.kind === "invalid_config" && result.error.message).toContain("CLOUDFLARE_API_TOKEN");
	});
});

describe("run_cli exit codes", () => {
	it("0 for --help, with usage on stdout", async () => {
		const result = await run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage: corpus");
		expect(result.stdout).toContain("--quiet");
	});

	it("0 for per-command --help", async () => {
		const result = await run(["stores", "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage: corpus stores");
	});

	it("2 with usage when no command is given", async () => {
		const result = await run([]);
		expect(result.code).toBe(2);
		expect(result.stdout).toContain("Usage: corpus");
	});

	it("2 for an unknown command, message on stderr", async () => {
		const result = await run(["nope"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Unknown command: nope");
		expect(result.stdout).toBe("");
	});

	it("1 for a command-arg parse error", async () => {
		const result = await run(["stores", "--bogus-flag"]);
		expect(result.code).toBe(1);
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	it("1 for a command error, message on stderr", async () => {
		const result = await run(["lineage"]);
		expect(result.code).toBe(1);
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(result.stdout).toBe("");
	});

	it("colours tables on a TTY, but emits no ANSI escapes under NO_COLOR", async () => {
		const dir = await make_tmp_dir("cli-main-color");
		const coloured = await run(["stores", "--file", dir], { stdout_is_tty: true });
		const plain = await run(["stores", "--file", dir], { env: { NO_COLOR: "1" }, stdout_is_tty: true });
		await remove_tmp_dir(dir);
		expect(coloured.code).toBe(0);
		expect(coloured.stdout.includes("\x1b")).toBe(true);
		expect(plain.code).toBe(0);
		expect(plain.stdout.includes("\x1b")).toBe(false);
	});
});

describe("run_cli --json", () => {
	it("a failing command writes one { error } document to stdout and nothing to stderr", async () => {
		const result = await run(["lineage", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("");
		const doc = error_doc_schema.parse(JSON.parse(result.stdout));
		expect(doc.error.message.length).toBeGreaterThan(0);
	});

	it("threads --json to the command (ctx.json)", async () => {
		const dir = await make_tmp_dir("cli-main");
		const result = await run(["stores", "--json", "--file", dir]);
		await remove_tmp_dir(dir);
		expect(result.code).toBe(0);
		expect(z.object({ stores: z.array(z.string()) }).parse(JSON.parse(result.stdout))).toEqual({ stores: [] });
	});
});

describe("unexpected throws", () => {
	it("prints one line and returns 1 by default", async () => {
		const result = await run(["--help"], { stdout_write: throwing_stdout });
		expect(result.code).toBe(1);
		expect(result.stderr).toBe("corpus: sink exploded\n");
	});

	it("CORPUS_DEBUG=1 prints the stack through the injected stderr sink", async () => {
		const result = await run(["--help"], { stdout_write: throwing_stdout, env: { CORPUS_DEBUG: "1" } });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("corpus: sink exploded\n");
		expect(result.stderr).toContain("Error: sink exploded");
		expect(result.stderr).toContain("cli-main.test.ts");
	});

	it("write_fatal stringifies non-Error values and never prints a stack for them", () => {
		const chunks: string[] = [];
		write_fatal("boom", true, (c) => {
			chunks.push(c);
		});
		expect(chunks).toEqual(["corpus: boom\n"]);
	});
});
