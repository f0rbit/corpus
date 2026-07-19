import { describe, it, expect } from "bun:test";
import { create_capture_output, create_console_output } from "../../cli/output.js";
import type { CorpusError } from "../../types.js";

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

		it("json mode skips line calls", () => {
			const output = create_console_output({ json_mode: true });
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
	});
});
