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
	type SnapshotMeta,
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
		test_dir = `/tmp/corpus-cli-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
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

		it("terminates on a parent cycle (a -> b -> a) instead of looping forever", async () => {
			// Hand-crafted via the raw backend (not corpus.stores.put, which is
			// append-only and can't retroactively create a mutual reference) —
			// same pattern cli-clone.test.ts's seed() helper uses.
			const meta_a: SnapshotMeta = {
				store_id: "cycle_a",
				version: "va",
				parents: [{ store_id: "cycle_b", version: "vb" }],
				created_at: new Date("2024-01-01T00:00:00.000Z"),
				content_hash: "hash-a",
				content_type: "application/json",
				size_bytes: 0,
				data_key: "cycle_a/hash-a",
			};
			const meta_b: SnapshotMeta = {
				store_id: "cycle_b",
				version: "vb",
				parents: [{ store_id: "cycle_a", version: "va" }],
				created_at: new Date("2024-01-01T00:00:00.000Z"),
				content_hash: "hash-b",
				content_type: "application/json",
				size_bytes: 0,
				data_key: "cycle_b/hash-b",
			};
			const put_a = await backend.metadata.put(meta_a);
			expect(put_a.ok).toBe(true);
			const put_b = await backend.metadata.put(meta_b);
			expect(put_b.ok).toBe(true);

			const output = create_capture_output();
			const ctx: CommandContext = {
				args: { depth: undefined },
				positionals: ["cycle_a", "va"],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
				_test_backend: backend,
			};

			const result = await lineage_command.run(ctx);
			expect(result.ok).toBe(true);

			// visit()'s seen-set caps the fetched node list at 2 (cycle_a/va,
			// cycle_b/vb) — it never re-fetches a store/version pair. The
			// render walks parent refs against that node list independently of
			// `visit`'s traversal order, so it re-encounters cycle_a/va as
			// cycle_b's parent; build_tree's own path-based guard renders that
			// as a terminal "(cycle)" leaf instead of recursing — 3 lines,
			// not an infinite tree.
			const lines = output.calls
				.filter((c): c is { type: "line"; text: string } => c.type === "line")
				.map((c) => c.text);
			expect(lines.length).toBe(3);
			expect(lines.some((l) => l.includes("(cycle)"))).toBe(true);
		});
	});

	describe("JSON output", () => {
		it("stores --json emits exactly one document, no table noise", async () => {
			const output = create_capture_output();
			const ctx: CommandContext = {
				args: { counts: false },
				positionals: [],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
				json: true,
				_test_backend: backend,
			};

			const result = await stores_command.run(ctx);
			expect(result.ok).toBe(true);

			const json_calls = output.calls.filter((c) => c.type === "json");
			expect(json_calls.length).toBe(1);
			expect(output.calls.filter((c) => c.type === "table").length).toBe(0);

			const doc = json_calls[0]!.value as Record<string, unknown>;
			expect(doc).toHaveProperty("stores");
			expect(Array.isArray(doc.stores)).toBe(true);
		});

		it("versions --json emits exactly one document matching the stable shape", async () => {
			const output = create_capture_output();
			const ctx: CommandContext = {
				args: {},
				positionals: ["store_a"],
				backend_selector: {},
				output,
				cwd: test_dir,
				env_vars: {},
				json: true,
				_test_backend: backend,
			};

			const result = await versions_command.run(ctx);
			expect(result.ok).toBe(true);

			const json_calls = output.calls.filter((c) => c.type === "json");
			expect(json_calls.length).toBe(1);
			expect(output.calls.filter((c) => c.type === "table").length).toBe(0);

			const doc = json_calls[0]!.value as Record<string, unknown>;
			expect(doc).toHaveProperty("store", "store_a");
			expect(doc).toHaveProperty("versions");
			expect(Array.isArray(doc.versions)).toBe(true);
			const first_version = (doc.versions as Record<string, unknown>[])[0];
			expect(first_version).toHaveProperty("store_id", "store_a");
			expect(first_version).toHaveProperty("content_hash");
			expect(first_version).toHaveProperty("data_key");
			expect(typeof first_version?.created_at).toBe("string");
		});

		it("show --json emits exactly one document matching the stable shape", async () => {
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
				json: true,
				_test_backend: backend,
			};

			const result = await show_command.run(ctx);
			expect(result.ok).toBe(true);

			const json_calls = output.calls.filter((c) => c.type === "json");
			expect(json_calls.length).toBe(1);
			expect(output.calls.filter((c) => c.type === "table").length).toBe(0);

			const doc = json_calls[0]!.value as Record<string, unknown>;
			expect(doc).toHaveProperty("meta");
			expect(doc).not.toHaveProperty("observations");
			const meta = doc.meta as Record<string, unknown>;
			expect(meta).toHaveProperty("store_id", "store_a");
			expect(meta).toHaveProperty("version", version);
		});

		it("lineage --json emits exactly one document matching the stable shape", async () => {
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
				json: true,
				_test_backend: backend,
			};

			const result = await lineage_command.run(ctx);
			expect(result.ok).toBe(true);

			const json_calls = output.calls.filter((c) => c.type === "json");
			expect(json_calls.length).toBe(1);
			expect(output.calls.filter((c) => c.type === "line").length).toBe(0);

			const doc = json_calls[0]!.value as Record<string, unknown>;
			expect(doc).toHaveProperty("root", { store: "store_b", version });
			expect(doc).toHaveProperty("nodes");
			expect(Array.isArray(doc.nodes)).toBe(true);
		});

		it("table mode never emits a JSON document (no pollution when --json is absent)", async () => {
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
			expect(output.calls.filter((c) => c.type === "json").length).toBe(0);
			expect(output.calls.filter((c) => c.type === "table").length).toBeGreaterThan(0);
		});
	});
});
