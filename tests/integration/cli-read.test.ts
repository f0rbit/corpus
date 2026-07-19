import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	type Corpus,
	type Store,
	type Backend,
} from "../../index.js";
import { create_capture_output } from "../../cli/output.js";
import type { CommandContext } from "../../cli/commands/index.js";
import { stores_command } from "../../cli/commands/stores.js";
import { versions_command } from "../../cli/commands/versions.js";
import { show_command } from "../../cli/commands/show.js";
import { lineage_command } from "../../cli/commands/lineage.js";
import { mkdirSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";

const test_schema = z.object({
	id: z.string(),
	text: z.string(),
});

type TestData = z.infer<typeof test_schema>;

describe("CLI read commands", () => {
	let corpus: Corpus<{ store_a: Store<TestData>; store_b: Store<TestData> }>;
	let backend: Backend;
	let test_dir: string;

	beforeEach(async () => {
		// Create test directory
		test_dir = `/tmp/corpus-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		mkdirSync(test_dir, { recursive: true });

		// Set up corpus with memory backend
		backend = create_memory_backend();
		corpus = create_corpus()
			.with_backend(backend)
			.with_store(define_store("store_a", json_codec(test_schema)))
			.with_store(define_store("store_b", json_codec(test_schema)))
			.build();

		// Create some test data in store_a
		await corpus.stores.store_a.put({ id: "1", text: "first version" });
		await new Promise((r) => setTimeout(r, 5));
		await corpus.stores.store_a.put({ id: "2", text: "second version" });

		// Create test data in store_b with parent reference
		const store_a_latest = await corpus.stores.store_a.get_latest();
		const store_a_version = store_a_latest.ok ? store_a_latest.value.meta.version : "";

		await corpus.stores.store_b.put(
			{ id: "3", text: "child of first" },
			{
				parents: [{ store_id: "store_a", version: store_a_version }],
			},
		);
	});

	afterEach(() => {
		// Clean up test directory
		if (existsSync(test_dir)) {
			rmSync(test_dir, { recursive: true, force: true });
		}
	});

	describe("stores command", () => {
		it("lists all stores", async () => {
			const output = create_capture_output();
			const ctx: CommandContext = {
				args: { counts: false },
				positionals: [],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
				_test_backend: backend,
			};

			const result = await stores_command.run(ctx);

			expect(result.ok).toBe(true);
			const table_calls = output.calls.filter((c) => c.type === "table");
			expect(table_calls.length).toBeGreaterThan(0);
		});

		it("counts versions with --counts flag", async () => {
			const output = create_capture_output();
			const ctx: CommandContext = {
				args: { counts: true },
				positionals: [],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
				_test_backend: backend,
			};

			const result = await stores_command.run(ctx);
			expect(result.ok).toBe(true);
		});
	});

	describe("versions command", () => {
		it("lists versions in a store", async () => {
			const output = create_capture_output();
			const ctx: CommandContext = {
				args: {},
				positionals: ["store_a"],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
			_test_backend: backend,
		};

		const result = await versions_command.run(ctx);
		expect(result.ok).toBe(true);

		const table_calls = output.calls.filter((c) => c.type === "table");
		expect(table_calls.length).toBeGreaterThan(0);
	});

	it("handles --limit flag", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { limit: "1" },
			positionals: ["store_a"],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await versions_command.run(ctx);
		expect(result.ok).toBe(true);
	});

	it("returns error for invalid limit", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { limit: "invalid" },
			positionals: ["store_a"],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await versions_command.run(ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("validation_error");
		}
	});

	it("returns error for missing store", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: {},
			positionals: [],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await versions_command.run(ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("validation_error");
		}
	});
});

describe("show command", () => {
	it("shows metadata for a snapshot", async () => {
		// Get the latest version
		const latest = await corpus.stores.store_a.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { observations: false },
			positionals: ["store_a", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await show_command.run(ctx);
		expect(result.ok).toBe(true);

		const table_calls = output.calls.filter((c) => c.type === "table");
		expect(table_calls.length).toBeGreaterThan(0);
	});

	it("returns not_found for non-existent version", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { observations: false },
			positionals: ["store_a", "nonexistent"],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await show_command.run(ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("not_found");
		}
	});

	it("returns error for missing arguments", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { observations: false },
			positionals: [],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await show_command.run(ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("validation_error");
		}
	});

	it("handles --observations flag gracefully when backend has no observations", async () => {
		const latest = await corpus.stores.store_a.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { observations: true },
			positionals: ["store_a", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await show_command.run(ctx);
		expect(result.ok).toBe(true);

		// Should have a note about observations not being enabled
		// Note calls are only added if observations is actually not available
		// (memory backend doesn't have observations support)
	});
});

describe("lineage command", () => {
	it("shows parent lineage", async () => {
		// Get store_b version which has a parent
		const latest = await corpus.stores.store_b.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { depth: undefined },
			positionals: ["store_b", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await lineage_command.run(ctx);
		expect(result.ok).toBe(true);

		const line_calls = output.calls.filter((c) => c.type === "line");
		expect(line_calls.length).toBeGreaterThan(0);
	});

	it("respects --depth flag", async () => {
		const latest = await corpus.stores.store_b.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { depth: "1" },
			positionals: ["store_b", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await lineage_command.run(ctx);
		expect(result.ok).toBe(true);
	});

	it("returns error for invalid depth", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { depth: "invalid" },
			positionals: ["store_b", "some_version"],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await lineage_command.run(ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("validation_error");
		}
	});

	it("handles missing ancestors gracefully", async () => {
		const latest = await corpus.stores.store_a.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { depth: undefined },
			positionals: ["store_a", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await lineage_command.run(ctx);
		expect(result.ok).toBe(true);
	});
});

describe("JSON output", () => {
	it("stores command outputs valid JSON structure", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { counts: false },
			positionals: [],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await stores_command.run(ctx);
		expect(result.ok).toBe(true);

		const json_calls = output.calls.filter((c) => c.type === "json") as Array<{
			type: "json";
			value: unknown;
		}>;
		expect(json_calls.length).toBeGreaterThan(0);
		if (json_calls.length > 0) {
			const json_call = json_calls[0]!;
			expect(json_call.value).toHaveProperty("stores");
			 
			const stores_list = (json_call.value as any).stores;
			expect(Array.isArray(stores_list)).toBe(true);
		}
	});

	it("versions command outputs valid JSON structure", async () => {
		const output = create_capture_output();
		const ctx: CommandContext = {
			args: {},
			positionals: ["store_a"],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await versions_command.run(ctx);
		expect(result.ok).toBe(true);

		const json_calls = output.calls.filter((c) => c.type === "json") as Array<{
			type: "json";
			value: unknown;
		}>;
		expect(json_calls.length).toBeGreaterThan(0);
		if (json_calls.length > 0) {
			const json_call = json_calls[0]!;
			 
			const json_val = json_call.value as any;
			expect(json_val).toHaveProperty("store");
			expect(json_val).toHaveProperty("versions");
			expect(Array.isArray(json_val.versions)).toBe(true);
		}
	});

	it("show command outputs valid JSON structure", async () => {
		const latest = await corpus.stores.store_a.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { observations: false },
			positionals: ["store_a", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await show_command.run(ctx);
		expect(result.ok).toBe(true);

		const json_calls = output.calls.filter((c) => c.type === "json") as Array<{
			type: "json";
			value: unknown;
		}>;
		expect(json_calls.length).toBeGreaterThan(0);
		if (json_calls.length > 0) {
			const json_call = json_calls[0]!;
			 
			const json_val = json_call.value as any;
			expect(json_val).toHaveProperty("meta");
		}
	});

	it("lineage command outputs valid JSON structure", async () => {
		const latest = await corpus.stores.store_b.get_latest();
		if (!latest.ok) return;
		const version = latest.value.meta.version;

		const output = create_capture_output();
		const ctx: CommandContext = {
			args: { depth: undefined },
			positionals: ["store_b", version],
			backend_selector: {},
			output,
			cwd: test_dir,
			env_vars: {},
			_test_backend: backend,
		};

		const result = await lineage_command.run(ctx);
		expect(result.ok).toBe(true);

		const json_calls = output.calls.filter((c) => c.type === "json") as Array<{
			type: "json";
			value: unknown;
		}>;
		expect(json_calls.length).toBeGreaterThan(0);
		if (json_calls.length > 0) {
			const json_call = json_calls[0]!;
			 
			const json_val = json_call.value as any;
			expect(json_val).toHaveProperty("root");
			expect(json_val).toHaveProperty("nodes");
			expect(Array.isArray(json_val.nodes)).toBe(true);
		}
	});
});
});
