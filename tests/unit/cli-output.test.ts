import { describe, it, expect } from "bun:test";
import { create_capture_output, create_console_output, render_tree } from "../../cli/output.js";
import type { OutputOpts, TreeNode } from "../../cli/output.js";
import { create_ansi } from "../../cli/ansi.js";
import { create_spinner } from "../../cli/spinner.js";
import type { CorpusError } from "../../types.js";

const ESC = "\x1b";

function base_opts(overrides: Partial<OutputOpts> = {}): OutputOpts {
	return {
		json: false,
		quiet: false,
		stdout_is_tty: false,
		stderr_is_tty: false,
		no_color: false,
		ci: false,
		...overrides,
	};
}

function capture_sinks(): {
	stdout: string[];
	stderr: string[];
	opts: Pick<OutputOpts, "stdout_write" | "stderr_write">;
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		opts: {
			stdout_write: (chunk: string | Uint8Array): void => {
				stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			},
			stderr_write: (chunk: string): void => {
				stderr.push(chunk);
			},
		},
	};
}

describe("cli output", () => {
	describe("create_capture_output", () => {
		it("captures line calls", () => {
			const output = create_capture_output();
			output.line("hello");
			output.line("world");

			expect(output.calls).toEqual([
				{ type: "line", text: "hello" },
				{ type: "line", text: "world" },
			]);
		});

		it("captures table calls", () => {
			const output = create_capture_output();
			const rows = [
				{ id: "1", name: "Alice" },
				{ id: "2", name: "Bob" },
			];
			const columns = ["id", "name"];
			output.table(rows, columns);

			expect(output.calls).toEqual([{ type: "table", rows, columns }]);
		});

		it("captures json calls", () => {
			const output = create_capture_output();
			output.json({ key: "value" });

			expect(output.calls).toEqual([{ type: "json", value: { key: "value" } }]);
		});

		it("captures error calls with CorpusError", () => {
			const output = create_capture_output();
			const err: CorpusError = { kind: "not_found", store_id: "test", version: "v1" };
			output.error(err);

			expect(output.calls).toEqual([{ type: "error", err }]);
		});

		it("captures error calls with string", () => {
			const output = create_capture_output();
			output.error("An error occurred");

			expect(output.calls).toEqual([{ type: "error", err: "An error occurred" }]);
		});

		it("captures bytes calls", () => {
			const output = create_capture_output();
			const data = new Uint8Array([1, 2, 3]);
			output.bytes(data);

			expect(output.calls).toEqual([{ type: "bytes", data }]);
		});

		it("captures note calls", () => {
			const output = create_capture_output();
			output.note("decoded via content_type");

			expect(output.calls).toEqual([{ type: "note", text: "decoded via content_type" }]);
		});

		it("captures spinner start/update/stop calls", () => {
			const output = create_capture_output();
			const handle = output.spinner("cloning...");
			handle.update("cloning (2/5)...");
			handle.stop("done");

			expect(output.calls).toEqual([
				{ type: "spinner_start", label: "cloning..." },
				{ type: "spinner_update", label: "cloning (2/5)..." },
				{ type: "spinner_stop", final: "done" },
			]);
		});

		it("json mode skips line calls", () => {
			const output = create_console_output(base_opts({ json: true }));
			// Lines should not print in JSON mode
			output.line("this should not appear");
		});

		it("error rendering exhaustively handles all CorpusError kinds", () => {
			const output = create_capture_output();

			const errors: CorpusError[] = [
				{ kind: "not_found", store_id: "test", version: "v1" },
				{ kind: "already_exists", store_id: "test", version: "v1" },
				{ kind: "storage_error", cause: new Error("test"), operation: "read" },
				{ kind: "decode_error", cause: new Error("test") },
				{ kind: "encode_error", cause: new Error("test") },
				{ kind: "hash_mismatch", expected: "abc", actual: "def" },
				{ kind: "invalid_config", message: "test" },
				{ kind: "validation_error", cause: new Error("test"), message: "test" },
				{ kind: "observation_not_found", id: "obs1" },
				{ kind: "transaction_aborted", reason: "returned_err" },
				{ kind: "partial_commit", ops_completed: 1, ops_failed: 1, cause: new Error("test") },
				{ kind: "concurrent_modification", store_id: "test", version: "v1" },
			];

			for (const err of errors) {
				output.error(err);
			}

			expect(output.calls.length).toBe(errors.length);
			expect(output.calls.every((call) => call.type === "error")).toBe(true);
		});
	});

	describe("create_console_output — table rendering", () => {
		const rows = [
			{ id: "1", name: "Alice" },
			{ id: "2", name: "Bob" },
		];
		const columns = ["id", "name"];

		it("colour off renders byte-identical plain aligned columns", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ stdout_is_tty: false, ...opts }));

			output.table(rows, columns);

			expect(stdout.join("")).toBe("id  name \n--  -----\n1   Alice\n2   Bob  \n");
		});

		it("stdout_is_tty true but NO_COLOR set still renders plain (no ESC bytes)", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ stdout_is_tty: true, no_color: true, ...opts }));

			output.table(rows, columns);

			const rendered = stdout.join("");
			expect(rendered).toBe("id  name \n--  -----\n1   Alice\n2   Bob  \n");
			expect(rendered.includes(ESC)).toBe(false);
		});

		it("colour on renders box-drawing borders + bold header, ESC bytes present", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ stdout_is_tty: true, ...opts }));

			output.table(rows, columns);

			const rendered = stdout.join("");
			expect(rendered.includes(ESC)).toBe(true);
			expect(rendered.includes("┌")).toBe(true);
			expect(rendered.includes("┐")).toBe(true);
			expect(rendered.includes("└")).toBe(true);
			expect(rendered.includes("┘")).toBe(true);
			expect(rendered.includes("│")).toBe(true);
			// bold header escape code
			expect(rendered.includes(`${ESC}[1m`)).toBe(true);
		});

		it("json mode emits rows as a single JSON document, zero ESC bytes", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ stdout_is_tty: true, json: true, ...opts }));

			output.table(rows, columns);

			expect(stdout.length).toBe(1);
			expect(stdout[0]?.includes(ESC)).toBe(false);
			expect(stdout[0]).toBe(`${JSON.stringify(rows, null, 2)}\n`);
		});
	});

	describe("create_console_output — note", () => {
		it("prints a dim note when decoration is enabled", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ stdout_is_tty: true, ...opts }));

			output.note("decoded via content_type");

			expect(stdout.join("").includes("decoded via content_type")).toBe(true);
		});

		it("suppresses notes when --quiet is set", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ quiet: true, ...opts }));

			output.note("should not appear");

			expect(stdout).toEqual([]);
		});

		it("suppresses notes in --json mode", () => {
			const { stdout, opts } = capture_sinks();
			const output = create_console_output(base_opts({ json: true, ...opts }));

			output.note("should not appear");

			expect(stdout).toEqual([]);
		});
	});

	describe("create_console_output — error routing", () => {
		it("human-readable errors go to the stderr sink", () => {
			const { stdout, stderr, opts } = capture_sinks();
			const output = create_console_output(base_opts(opts));

			output.error({ kind: "observation_not_found", id: "obs1" });

			expect(stdout).toEqual([]);
			expect(stderr.join("").includes("obs1")).toBe(true);
		});

		it("json-mode errors go to the stdout sink as one document", () => {
			const { stdout, stderr, opts } = capture_sinks();
			const output = create_console_output(base_opts({ json: true, ...opts }));

			output.error({ kind: "observation_not_found", id: "obs1" });

			expect(stderr).toEqual([]);
			expect(stdout.length).toBe(1);
			expect(stdout[0]).toBe(
				`${JSON.stringify({ error: "observation_not_found", message: "error: Observation obs1 not found" }, null, 2)}\n`,
			);
		});
	});

	describe("create_console_output — spinner enable matrix", () => {
		const enabled_opts = (): OutputOpts =>
			base_opts({ stderr_is_tty: true, ci: false, quiet: false, json: false, no_color: false });

		it("spinner writes only to the stderr sink and erases on stop", () => {
			const { stdout, stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), ...opts });

			const handle = output.spinner("cloning...");
			handle.stop("done");

			expect(stdout).toEqual([]);
			expect(stderr.length).toBeGreaterThan(0);
			// no stray ESC bytes on stdout, and stdout stays untouched entirely
			expect(stdout.join("").includes(ESC)).toBe(false);
			expect(stdout.join("").includes("\r")).toBe(false);
		});

		it("stop() clears the interval — no further writes after stop", async () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), ...opts });

			const handle = output.spinner("cloning...");
			handle.stop();
			const count_after_stop = stderr.length;

			await Bun.sleep(150); // > default 80ms spinner interval

			expect(stderr.length).toBe(count_after_stop);
		});

		it("disabled by --json: writes nothing", () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), json: true, ...opts });

			const handle = output.spinner("cloning...");
			handle.update("still cloning...");
			handle.stop("done");

			expect(stderr).toEqual([]);
		});

		it("disabled by --quiet: writes nothing", () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), quiet: true, ...opts });

			output.spinner("cloning...").stop("done");

			expect(stderr).toEqual([]);
		});

		it("disabled by CI: writes nothing", () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), ci: true, ...opts });

			output.spinner("cloning...").stop("done");

			expect(stderr).toEqual([]);
		});

		it("disabled by NO_COLOR: writes nothing", () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), no_color: true, ...opts });

			output.spinner("cloning...").stop("done");

			expect(stderr).toEqual([]);
		});

		it("disabled when stderr is not a TTY: writes nothing", () => {
			const { stderr, opts } = capture_sinks();
			const output = create_console_output({ ...enabled_opts(), stderr_is_tty: false, ...opts });

			output.spinner("cloning...").stop("done");

			expect(stderr).toEqual([]);
		});
	});

	describe("cli/ansi.ts — create_ansi", () => {
		it("wraps text in ANSI codes when enabled", () => {
			const ansi = create_ansi(true);
			expect(ansi.bold("hi")).toBe(`${ESC}[1mhi${ESC}[0m`);
			expect(ansi.dim("hi")).toBe(`${ESC}[2mhi${ESC}[0m`);
		});

		it("returns identity functions when disabled", () => {
			const ansi = create_ansi(false);
			expect(ansi.bold("hi")).toBe("hi");
			expect(ansi.dim("hi")).toBe("hi");
			expect(ansi.red("hi")).toBe("hi");
		});
	});

	describe("cli/spinner.ts — create_spinner", () => {
		it("disabled spinner is a full no-op", () => {
			const chunks: string[] = [];
			const spinner = create_spinner({ write: (s) => chunks.push(s), enabled: false });

			spinner.start("loading");
			spinner.update("still loading");
			spinner.stop("done");

			expect(chunks).toEqual([]);
		});

		it("enabled spinner writes frames via the injected sink and erases on stop", () => {
			const chunks: string[] = [];
			const spinner = create_spinner({ write: (s) => chunks.push(s), enabled: true });

			spinner.start("loading");
			expect(chunks.length).toBe(1);
			expect(chunks[0]?.includes("loading")).toBe(true);

			spinner.stop();
			expect(chunks.length).toBe(2);
			expect(chunks[1]?.includes("\r")).toBe(true);
		});
	});

	describe("render_tree", () => {
		it("connects children with box-drawing tree connectors", () => {
			const tree: TreeNode = {
				label: "v3",
				children: [
					{
						label: "v2",
						children: [{ label: "v1", children: [] }],
					},
					{ label: "v1b", children: [] },
				],
			};

			expect(render_tree(tree)).toEqual(["v3", "├─ v2", "│  └─ v1", "└─ v1b"]);
		});

		it("renders a single node with no children", () => {
			expect(render_tree({ label: "root", children: [] })).toEqual(["root"]);
		});
	});

	describe("no console/process access outside cli/output.ts", () => {
		it("cli/ansi.ts is pure", async () => {
			const source = await Bun.file(import.meta.dirname + "/../../cli/ansi.ts").text();
			expect(source.includes("console.")).toBe(false);
			expect(source.includes("process.")).toBe(false);
		});

		it("cli/spinner.ts is pure", async () => {
			const source = await Bun.file(import.meta.dirname + "/../../cli/spinner.ts").text();
			expect(source.includes("console.")).toBe(false);
			expect(source.includes("process.")).toBe(false);
		});
	});

	describe("cli spawn smoke test", () => {
		it("runs --help and exits 0", async () => {
			const proc = Bun.spawn(["bun", "cli/index.ts", "--help"], {
				cwd: import.meta.dirname + "/../..",
				stdout: "pipe",
				stderr: "pipe",
			});

			const stdout = await proc.stdout.text();
			const exit_code = await proc.exited;

			expect(exit_code).toBe(0);
			expect(stdout).toContain("corpus");
			expect(stdout).toContain("stores");
			expect(stdout).toContain("versions");
			expect(stdout).toContain("show");
			expect(stdout).toContain("cat");
			expect(stdout).toContain("lineage");
			expect(stdout).toContain("clone");
			expect(stdout).toContain("--quiet");
		});

		it("exits 2 on unknown command", async () => {
			const proc = Bun.spawn(["bun", "cli/index.ts", "unknown"], {
				cwd: import.meta.dirname + "/../..",
				stdout: "ignore",
				stderr: "ignore",
			});

			const exit_code = await proc.exited;
			expect(exit_code).toBe(2);
		});

		it("exits 1 on command error", async () => {
			const proc = Bun.spawn(["bun", "cli/index.ts", "stores"], {
				cwd: import.meta.dirname + "/../..",
				stdout: "ignore",
				stderr: "ignore",
			});

			const exit_code = await proc.exited;
			expect(exit_code).toBe(1);
		});

		it("runs --help with NO_COLOR set and exits 0 promptly", async () => {
			const proc = Bun.spawn(["bun", "cli/index.ts", "--help"], {
				cwd: import.meta.dirname + "/../..",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, NO_COLOR: "1" },
			});

			const stdout = await proc.stdout.text();
			const exit_code = await proc.exited;

			expect(exit_code).toBe(0);
			expect(stdout.includes(ESC)).toBe(false);
		});
	});
});
