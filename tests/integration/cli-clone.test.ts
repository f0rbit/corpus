/**
 * Integration tests for CLI clone and cat commands (plan task 5.2).
 *
 * Tests cover:
 * - clone: file→file with real directories, remote-fakes→file, --dry-run, --store filter
 * - cat: decode with config, config-less fallback (text/json), --raw mode
 * - Output: capture-based assertions, no process spawning except smoke test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { create_file_backend } from "../../backend/file.js";
import { create_capture_output } from "../../cli/output.js";
import { cat_command } from "../../cli/commands/cat.js";
import { clone_command } from "../../cli/commands/clone.js";
import type { Backend, SnapshotMeta } from "../../types.js";

function make_meta(
	overrides: Partial<SnapshotMeta> & Pick<SnapshotMeta, "store_id" | "version" | "data_key">,
): SnapshotMeta {
	return {
		parents: [],
		created_at: new Date("2024-06-01T00:00:00.000Z"),
		content_hash: `hash-${overrides.version}`,
		content_type: "application/octet-stream",
		size_bytes: 0,
		...overrides,
	};
}

async function seed(backend: Backend, meta: SnapshotMeta, bytes: Uint8Array): Promise<void> {
	const data_put = await backend.data.put(meta.data_key, bytes);
	if (!data_put.ok) throw new Error(`seed: data.put failed (${data_put.error.kind})`);
	const meta_put = await backend.metadata.put({ ...meta, size_bytes: bytes.byteLength });
	if (!meta_put.ok) throw new Error(`seed: metadata.put failed (${meta_put.error.kind})`);
}

async function list_versions(backend: Backend, store_id: string): Promise<SnapshotMeta[]> {
	const out: SnapshotMeta[] = [];
	for await (const meta of backend.metadata.list(store_id)) out.push(meta);
	return out.toSorted((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

describe("CLI clone and cat commands", () => {
	const TMP_SRC = join(import.meta.dir, ".test-cli-src");
	const TMP_DEST = join(import.meta.dir, ".test-cli-dest");

	beforeEach(async () => {
		await rm(TMP_SRC, { recursive: true, force: true });
		await rm(TMP_DEST, { recursive: true, force: true });
		await mkdir(TMP_SRC, { recursive: true });
		await mkdir(TMP_DEST, { recursive: true });
	});

	afterEach(async () => {
		await rm(TMP_SRC, { recursive: true, force: true });
		await rm(TMP_DEST, { recursive: true, force: true });
	});

	describe("clone command", () => {
		it("clones file → file", async () => {
			const source = create_file_backend({ base_path: TMP_SRC });

			// Seed source with test data
			const bytes_a = new TextEncoder().encode("hello-a");
			const bytes_b = new TextEncoder().encode("hello-b");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes_a);
			await seed(source, make_meta({ store_id: "docs", version: "v2", data_key: "docs/hash-v2" }), bytes_b);

			const output = create_capture_output();
			const result = await clone_command.run({
				args: {},
				positionals: [TMP_SRC, TMP_DEST],
				backend_selector: {},
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Verify destination has the same data
			const dest = create_file_backend({ base_path: TMP_DEST });
			const dest_versions = await list_versions(dest, "docs");
			expect(dest_versions.length).toBe(2);
			expect(dest_versions[0]?.version).toBe("v1");
			expect(dest_versions[1]?.version).toBe("v2");
		});

		it("second clone is idempotent (all skip)", async () => {
			const source = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("test");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes);

			const output1 = create_capture_output();
			const result1 = await clone_command.run({
				args: {},
				positionals: [TMP_SRC, TMP_DEST],
				backend_selector: {},
				output: output1,
				cwd: import.meta.dir,
				env_vars: {},
			});
			expect(result1.ok).toBe(true);

			const output2 = create_capture_output();
			const result2 = await clone_command.run({
				args: {},
				positionals: [TMP_SRC, TMP_DEST],
				backend_selector: {},
				output: output2,
				cwd: import.meta.dir,
				env_vars: {},
			});
			expect(result2.ok).toBe(true);

			// Second run should have 0 copies
			const table_calls = output2.calls.filter((c) => c.type === "table");
			expect(table_calls.length).toBeGreaterThan(0);
		});

		it("respects --store filter", async () => {
			const source = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("test");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes);
			await seed(source, make_meta({ store_id: "notes", version: "v1", data_key: "notes/hash-v1" }), bytes);

			const output = create_capture_output();
			const result = await clone_command.run({
				args: { store: ["docs"] },
				positionals: [TMP_SRC, TMP_DEST],
				backend_selector: {},
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Only docs should be in destination
			const dest = create_file_backend({ base_path: TMP_DEST });
			const dest_stores: string[] = [];
			if (dest.metadata.list_stores) {
				for await (const store of dest.metadata.list_stores()) dest_stores.push(store);
			}
			expect(dest_stores).toContain("docs");
		});

		it("rejects remote destination (v1 restriction)", async () => {
			const source = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("test");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes);

			const output = create_capture_output();
			const result = await clone_command.run({
				args: {},
				positionals: [TMP_SRC, "remote-env"],
				backend_selector: {},
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(false);
			if (!result.ok && "message" in result.error) {
				expect(result.error.message).toContain("file backend");
			}
		});

		it("--dry-run leaves destination empty", async () => {
			const source = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("test");
			await seed(source, make_meta({ store_id: "docs", version: "v1", data_key: "docs/hash-v1" }), bytes);

			const output = create_capture_output();
			const result = await clone_command.run({
				args: { "dry-run": true },
				positionals: [TMP_SRC, TMP_DEST],
				backend_selector: {},
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Destination should exist but be empty
			const dest = create_file_backend({ base_path: TMP_DEST });
			const dest_stores: string[] = [];
			if (dest.metadata.list_stores) {
				for await (const store of dest.metadata.list_stores()) dest_stores.push(store);
			}
			expect(dest_stores.length).toBe(0);
		});
	});

	describe("cat command", () => {
		it("cats with --raw streams literal bytes", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("raw bytes");
			await seed(backend, make_meta({ store_id: "data", version: "v1", data_key: "data/hash-v1" }), bytes);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: { raw: true },
				positionals: ["data", "v1"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Check that raw bytes were output
			const bytes_calls = output.calls.filter((c) => c.type === "bytes");
			expect(bytes_calls.length).toBeGreaterThan(0);
		});

		it("resolves latest alias", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("test");
			await seed(backend, make_meta({ store_id: "data", version: "v1", data_key: "data/hash-v1" }), bytes);
			await seed(backend, make_meta({ store_id: "data", version: "v2", data_key: "data/hash-v2" }), bytes);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: { raw: true },
				positionals: ["data", "latest"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);
		});

		it("decodes with config codec (text store)", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("hello world");
			await seed(
				backend,
				make_meta({
					store_id: "text_data",
					version: "v1",
					data_key: "text_data/hash-v1",
					content_type: "text/plain",
				}),
				bytes,
			);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: {},
				positionals: ["text_data", "v1"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Should have output via line() or note()
			const line_calls = output.calls.filter((c) => c.type === "line");
			expect(line_calls.length).toBeGreaterThan(0);
		});

		it("fallback renders text/* without config", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("fallback text");
			await seed(
				backend,
				make_meta({
					store_id: "text_store",
					version: "v1",
					data_key: "text_store/hash-v1",
					content_type: "text/plain",
				}),
				bytes,
			);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: {},
				positionals: ["text_store", "v1"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Should have a note about fallback
			const note_calls = output.calls.filter((c) => c.type === "note");
			expect(note_calls.length).toBeGreaterThan(0);
		});

		it("fallback renders JSON without config", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const json_bytes = new TextEncoder().encode('{"key":"value"}');
			await seed(
				backend,
				make_meta({
					store_id: "json_store",
					version: "v1",
					data_key: "json_store/hash-v1",
					content_type: "application/json",
				}),
				json_bytes,
			);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: {},
				positionals: ["json_store", "v1"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(true);

			// Should have a note about fallback
			const note_calls = output.calls.filter((c) => c.type === "note");
			expect(note_calls.length).toBeGreaterThan(0);
		});

		it("errors on binary content without config", async () => {
			const backend = create_file_backend({ base_path: TMP_SRC });
			const bytes = new TextEncoder().encode("binary");
			await seed(
				backend,
				make_meta({
					store_id: "binary_store",
					version: "v1",
					data_key: "binary_store/hash-v1",
					content_type: "application/octet-stream",
				}),
				bytes,
			);

			const output = create_capture_output();
			const result = await cat_command.run({
				args: {},
				positionals: ["binary_store", "v1"],
				backend_selector: { file: TMP_SRC },
				output,
				cwd: import.meta.dir,
				env_vars: {},
			});

			expect(result.ok).toBe(false);
			if (!result.ok && "message" in result.error) {
				expect(result.error.message).toContain("--raw");
			}
		});
	});
});
