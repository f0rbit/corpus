/**
 * CLI command error branches and resolve paths (phase 4.4).
 *
 * Commands are driven through `run(ctx)` WITHOUT `_test_backend` for the
 * resolve path (file selector + temp cwd), and with an injected backend for the
 * branch tests. Every temp cwd carries a `.git` dir so upward config/wrangler
 * discovery never escapes into the real checkout.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { create_file_backend } from "../../backend/file.js";
import { create_memory_backend } from "../../backend/memory.js";
import { define_observation_type } from "../../observations/index.js";
import { create_error_sink, track_errors } from "../../cli/backend-errors.js";
import { create_capture_output, create_console_output, write_fatal, type CaptureOutput } from "../../cli/output.js";
import type { Command, CommandContext } from "../../cli/commands/index.js";
import { cat_command } from "../../cli/commands/cat.js";
import { lineage_command } from "../../cli/commands/lineage.js";
import { show_command } from "../../cli/commands/show.js";
import { stores_command } from "../../cli/commands/stores.js";
import { versions_command } from "../../cli/commands/versions.js";
import type { Backend, CorpusError, Result, SnapshotMeta } from "../../types.js";
import { err } from "../../types.js";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";

const make_meta = (overrides: Partial<SnapshotMeta> & Pick<SnapshotMeta, "store_id" | "version">): SnapshotMeta => ({
	parents: [],
	created_at: new Date("2024-06-01T00:00:00.000Z"),
	content_hash: `hash-${overrides.version}`,
	content_type: "text/plain",
	size_bytes: 0,
	data_key: `${overrides.store_id}/hash-${overrides.version}`,
	...overrides,
});

async function seed(backend: Backend, meta: SnapshotMeta, text = "hello"): Promise<void> {
	const bytes = new TextEncoder().encode(text);
	const data_put = await backend.data.put(meta.data_key, bytes);
	if (!data_put.ok) throw new Error(`seed: data.put failed (${data_put.error.kind})`);
	const meta_put = await backend.metadata.put({ ...meta, size_bytes: bytes.byteLength });
	if (!meta_put.ok) throw new Error(`seed: metadata.put failed (${meta_put.error.kind})`);
}

async function with_tmp<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await make_tmp_dir(prefix);
	await mkdir(join(dir, ".git"), { recursive: true });
	try {
		return await fn(dir);
	} finally {
		await remove_tmp_dir(dir);
	}
}

type Run = { result: Result<void, CorpusError>; output: CaptureOutput };

async function run(command: Command, over: Partial<CommandContext> & { cwd: string }): Promise<Run> {
	const output = create_capture_output();
	const result = await command.run({
		args: {},
		positionals: [],
		backend_selector: {},
		output,
		env_vars: {},
		...over,
	});
	return { result, output };
}

function failure(r: Run): CorpusError {
	if (r.result.ok) throw new Error("expected an error result");
	return r.result.error;
}

const message_of = (e: CorpusError): string => ("message" in e && typeof e.message === "string" ? e.message : "");

const tables = (o: CaptureOutput): Record<string, string>[][] =>
	o.calls.flatMap((c) => (c.type === "table" ? [c.rows] : []));
const lines = (o: CaptureOutput): string[] => o.calls.flatMap((c) => (c.type === "line" ? [c.text] : []));
const jsons = (o: CaptureOutput): unknown[] => o.calls.flatMap((c) => (c.type === "json" ? [c.value] : []));
const notes = (o: CaptureOutput): string[] => o.calls.flatMap((c) => (c.type === "note" ? [c.text] : []));

describe("resolve path (no _test_backend)", () => {
	const cases: Array<{
		name: string;
		command: Command;
		positionals: string[];
		expect_out: (o: CaptureOutput) => void;
	}> = [
		{
			name: "stores",
			command: stores_command,
			positionals: [],
			expect_out: (o) => {
				expect(tables(o)[0]).toEqual([{ id: "docs" }]);
			},
		},
		{
			name: "versions",
			command: versions_command,
			positionals: ["docs"],
			expect_out: (o) => {
				expect(tables(o)[0]?.map((r) => r.version)).toEqual(["v1"]);
			},
		},
		{
			name: "show",
			command: show_command,
			positionals: ["docs", "v1"],
			expect_out: (o) => {
				expect(tables(o)[0]).toContainEqual({ key: "Store ID", value: "docs" });
			},
		},
		{
			name: "lineage",
			command: lineage_command,
			positionals: ["docs", "v1"],
			expect_out: (o) => {
				expect(lines(o)).toEqual(["docs/v1"]);
			},
		},
		{
			name: "cat",
			command: cat_command,
			positionals: ["docs", "v1"],
			expect_out: (o) => {
				expect(lines(o)).toEqual(["hello"]);
			},
		},
	];

	for (const c of cases) {
		it(`${c.name}: file selector resolves a real file backend`, async () => {
			const store_dir = await make_tmp_dir("cli-errors-store");
			try {
				await seed(create_file_backend({ base_path: store_dir }), make_meta({ store_id: "docs", version: "v1" }));
				await with_tmp("cli-errors-cwd", async (cwd) => {
					const r = await run(c.command, { cwd, positionals: c.positionals, backend_selector: { file: store_dir } });
					expect(r.result.ok).toBe(true);
					c.expect_out(r.output);
				});
			} finally {
				await remove_tmp_dir(store_dir);
			}
		});

		it(`${c.name}: a malformed wrangler.toml propagates the sniff error`, async () => {
			await with_tmp("cli-errors-bad-wrangler", async (cwd) => {
				await writeFile(join(cwd, "wrangler.toml"), "this = = not [toml");
				const r = await run(c.command, { cwd, positionals: c.positionals, backend_selector: { file: cwd } });
				const error = failure(r);
				expect(error.kind).toBe("validation_error");
				expect(message_of(error)).toContain("failed to parse wrangler.toml");
			});
		});
	}

	it("a malformed corpus.config.ts propagates the load error (stores, cat)", async () => {
		await with_tmp("cli-errors-bad-config", async (cwd) => {
			await writeFile(join(cwd, "corpus.config.ts"), `export default { stores: "nope" };`);
			const stores = failure(await run(stores_command, { cwd }));
			expect(message_of(stores)).toContain("invalid corpus config");
			const cat = failure(await run(cat_command, { cwd, positionals: ["docs", "v1"] }));
			expect(message_of(cat)).toContain("invalid corpus config");
		});
	});

	it("an unresolvable remote selector fails in resolve_backend, naming what is missing", async () => {
		await with_tmp("cli-errors-unresolved", async (cwd) => {
			for (const command of [stores_command, versions_command, show_command, lineage_command, cat_command]) {
				const r = await run(command, { cwd, positionals: ["docs", "v1"], backend_selector: { env: "prod" } });
				expect(failure(r).kind).toBe("invalid_config");
				expect(message_of(failure(r))).toContain("CLOUDFLARE_API_TOKEN");
			}
		});
	});
});

describe("argument errors", () => {
	const missing: Array<{ command: Command; positionals: string[]; kind: CorpusError["kind"]; text: string }> = [
		{
			command: cat_command,
			positionals: [],
			kind: "invalid_config",
			text: "cat requires <store> and <version> arguments",
		},
		{
			command: cat_command,
			positionals: ["docs"],
			kind: "invalid_config",
			text: "cat requires <store> and <version> arguments",
		},
		{
			command: show_command,
			positionals: ["docs"],
			kind: "validation_error",
			text: "store and version arguments are required",
		},
		{
			command: lineage_command,
			positionals: [],
			kind: "validation_error",
			text: "store and version arguments are required",
		},
		{
			command: lineage_command,
			positionals: ["docs"],
			kind: "validation_error",
			text: "store and version arguments are required",
		},
		{ command: versions_command, positionals: [], kind: "validation_error", text: "store argument is required" },
	];

	for (const m of missing) {
		it(`${m.command.name} with ${String(m.positionals.length)} positional(s) is ${m.kind}`, async () => {
			const error = failure(await run(m.command, { cwd: import.meta.dir, positionals: m.positionals }));
			expect(error.kind).toBe(m.kind);
			expect(message_of(error)).toBe(m.text);
		});
	}

	for (const bad of ["0", "x", "-3"]) {
		it(`lineage --depth ${bad} is rejected`, async () => {
			const r = await run(lineage_command, {
				cwd: import.meta.dir,
				positionals: ["docs", "v1"],
				args: { depth: bad },
				_test_backend: create_memory_backend(),
			});
			expect(message_of(failure(r))).toBe("invalid --depth: must be a positive number");
		});
	}

	for (const flag of ["before", "after"] as const) {
		for (const bad of ["2025-01-01", "yesterday", ""]) {
			it(`versions --${flag} ${JSON.stringify(bad)} is rejected`, async () => {
				const r = await run(versions_command, {
					cwd: import.meta.dir,
					positionals: ["docs"],
					args: { [flag]: bad },
					_test_backend: create_memory_backend(),
				});
				expect(failure(r).kind).toBe("validation_error");
				expect(message_of(failure(r))).toBe(`invalid --${flag} date: ${bad}`);
			});
		}
	}

	for (const bad of ["0", "abc"]) {
		it(`versions --limit ${bad} is rejected`, async () => {
			const r = await run(versions_command, {
				cwd: import.meta.dir,
				positionals: ["docs"],
				args: { limit: bad },
				_test_backend: create_memory_backend(),
			});
			expect(message_of(failure(r))).toBe("invalid --limit: must be a positive number");
		});
	}

	it("versions applies a full ISO datetime --before/--after window and --tag/--entity", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "docs", version: "old", created_at: new Date("2020-01-01T00:00:00Z") }));
		await seed(
			backend,
			make_meta({
				store_id: "docs",
				version: "mid",
				created_at: new Date("2022-01-01T00:00:00Z"),
				tags: ["t"],
				entity_key: "e1",
			}),
		);
		await seed(backend, make_meta({ store_id: "docs", version: "new", created_at: new Date("2024-01-01T00:00:00Z") }));

		const window = await run(versions_command, {
			cwd: import.meta.dir,
			positionals: ["docs"],
			args: { after: "2021-01-01T00:00:00Z", before: "2023-01-01T00:00:00Z" },
			_test_backend: backend,
		});
		expect(window.result.ok).toBe(true);
		expect(tables(window.output)[0]?.map((r) => r.version)).toEqual(["mid"]);

		const keyed = await run(versions_command, {
			cwd: import.meta.dir,
			positionals: ["docs"],
			args: { tag: ["t"], entity: "e1" },
			_test_backend: backend,
		});
		expect(tables(keyed.output)[0]?.map((r) => [r.version, r.tags, r.entity_key])).toEqual([["mid", "t", "e1"]]);
	});
});

const config_with = (decode_body: string): string =>
	`export default { stores: [{ id: "docs", codec: { decode: async (bytes) => { ${decode_body} } } }] };`;

// Real backends report a listing failure while the iterator is consumed, not when it is created.
const empty_listing = <T>(on_start: () => void): AsyncIterable<T> => ({
	[Symbol.asyncIterator]: () => ({
		next: () => {
			on_start();
			return Promise.resolve({ done: true as const, value: undefined });
		},
	}),
});

describe("cat branches", () => {
	it("decodes through the config codec: table, --json and decode failure", async () => {
		const store_dir = await make_tmp_dir("cli-errors-cat-store");
		try {
			const backend = create_file_backend({ base_path: store_dir });
			await seed(
				backend,
				make_meta({ store_id: "docs", version: "v1", content_type: "application/octet-stream" }),
				"abcde",
			);

			await with_tmp("cli-errors-cat-ok", async (cwd) => {
				await writeFile(join(cwd, "corpus.config.ts"), config_with("return { length: bytes.length };"));
				const base = { cwd, positionals: ["docs", "v1"], backend_selector: { file: store_dir } };

				const table = await run(cat_command, base);
				expect(table.result.ok).toBe(true);
				expect(lines(table.output)).toEqual([JSON.stringify({ length: 5 }, null, 2)]);

				const json = await run(cat_command, { ...base, json: true });
				expect(json.result.ok).toBe(true);
				expect(jsons(json.output)).toEqual([
					{
						store: "docs",
						version: "v1",
						content_type: "application/octet-stream",
						size_bytes: 5,
						encoding: "utf8",
						content: JSON.stringify({ length: 5 }),
					},
				]);
				expect(lines(json.output)).toEqual([]);
			});

			await with_tmp("cli-errors-cat-throw", async (cwd) => {
				await writeFile(join(cwd, "corpus.config.ts"), config_with(`throw new Error("codec exploded");`));
				const r = await run(cat_command, { cwd, positionals: ["docs", "v1"], backend_selector: { file: store_dir } });
				const error = failure(r);
				expect(error.kind).toBe("decode_error");
				expect(error.kind === "decode_error" && error.cause.message).toBe("codec exploded");
			});

			await with_tmp("cli-errors-cat-throw-string", async (cwd) => {
				await writeFile(join(cwd, "corpus.config.ts"), config_with(`throw "plain string";`));
				const error = failure(
					await run(cat_command, { cwd, positionals: ["docs", "v1"], backend_selector: { file: store_dir } }),
				);
				expect(error.kind === "decode_error" && error.cause.message).toBe("plain string");
			});

			await with_tmp("cli-errors-cat-no-codec", async (cwd) => {
				await writeFile(join(cwd, "corpus.config.ts"), `export default { stores: [{ id: "docs" }] };`);
				const error = failure(
					await run(cat_command, { cwd, positionals: ["docs", "v1"], backend_selector: { file: store_dir } }),
				);
				expect(error.kind).toBe("invalid_config");
				expect(message_of(error)).toContain("cannot render application/octet-stream without a codec");
				expect(message_of(error)).toContain("--raw");
			});
		} finally {
			await remove_tmp_dir(store_dir);
		}
	});

	it("content-type fallback: json renders, invalid json is decode_error, text and --raw work", async () => {
		const store_dir = await make_tmp_dir("cli-errors-cat-fallback");
		try {
			const backend = create_file_backend({ base_path: store_dir });
			await seed(backend, make_meta({ store_id: "j", version: "ok", content_type: "application/json" }), `{"a":1}`);
			await seed(backend, make_meta({ store_id: "j", version: "bad", content_type: "application/json" }), "{not json");
			await seed(backend, make_meta({ store_id: "t", version: "v1", content_type: "text/plain" }), "plain text");

			await with_tmp("cli-errors-cat-fb-cwd", async (cwd) => {
				const sel = { file: store_dir };

				const ok_table = await run(cat_command, { cwd, positionals: ["j", "ok"], backend_selector: sel });
				expect(lines(ok_table.output)).toEqual([JSON.stringify({ a: 1 }, null, 2)]);
				expect(notes(ok_table.output)).toEqual(["(no corpus.config.ts — rendered from content_type, not a codec)"]);

				const ok_json = await run(cat_command, { cwd, positionals: ["j", "ok"], backend_selector: sel, json: true });
				expect(jsons(ok_json.output)).toEqual([
					{
						store: "j",
						version: "ok",
						content_type: "application/json",
						size_bytes: 7,
						encoding: "utf8",
						content: `{"a":1}`,
					},
				]);

				const bad = failure(await run(cat_command, { cwd, positionals: ["j", "bad"], backend_selector: sel }));
				expect(bad.kind).toBe("decode_error");
				expect(bad.kind === "decode_error" && bad.cause).toBeInstanceOf(Error);

				const text_json = await run(cat_command, { cwd, positionals: ["t", "v1"], backend_selector: sel, json: true });
				expect(jsons(text_json.output)).toEqual([
					{
						store: "t",
						version: "v1",
						content_type: "text/plain",
						size_bytes: 10,
						encoding: "utf8",
						content: "plain text",
					},
				]);

				const raw_json = await run(cat_command, {
					cwd,
					positionals: ["t", "v1"],
					args: { raw: true },
					backend_selector: sel,
					json: true,
				});
				expect(jsons(raw_json.output)).toEqual([
					{
						store: "t",
						version: "v1",
						content_type: "text/plain",
						size_bytes: 10,
						encoding: "base64",
						content: Buffer.from("plain text").toString("base64"),
					},
				]);

				const raw = await run(cat_command, {
					cwd,
					positionals: ["t", "v1"],
					args: { raw: true },
					backend_selector: sel,
				});
				const bytes = raw.output.calls.flatMap((c) => (c.type === "bytes" ? [new TextDecoder().decode(c.data)] : []));
				expect(bytes).toEqual(["plain text"]);

				const missing = failure(await run(cat_command, { cwd, positionals: ["t", "nope"], backend_selector: sel }));
				expect(missing.kind).toBe("not_found");
			});
		} finally {
			await remove_tmp_dir(store_dir);
		}
	});
});

describe("show branches", () => {
	const note_type = define_observation_type("note", z.object({ text: z.string() }));

	async function seeded_memory(): Promise<Backend> {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "a", version: "v1" }));
		await seed(backend, make_meta({ store_id: "a", version: "v2" }));
		await seed(
			backend,
			make_meta({
				store_id: "b",
				version: "c1",
				tags: ["x", "y"],
				invoked_at: new Date("2024-07-01T00:00:00.000Z"),
				parents: [
					{ store_id: "a", version: "v1", role: "input" },
					{ store_id: "a", version: "v2" },
				],
			}),
		);
		return backend;
	}

	it("renders parents with and without a role, tags and invoked_at", async () => {
		const r = await run(show_command, {
			cwd: import.meta.dir,
			positionals: ["b", "c1"],
			_test_backend: await seeded_memory(),
		});
		expect(r.result.ok).toBe(true);
		const rows = tables(r.output)[0] ?? [];
		expect(rows).toContainEqual({ key: "Tags", value: "x, y" });
		expect(rows).toContainEqual({ key: "Invoked At", value: "2024-07-01T00:00:00.000Z" });
		const at = rows.findIndex((row) => row.key === "Parents");
		expect(rows.slice(at)).toEqual([
			{ key: "Parents", value: "" },
			{ key: "", value: "a/v1 (input)" },
			{ key: "", value: "a/v2" },
		]);
	});

	it("a snapshot without parents renders no Parents row", async () => {
		const r = await run(show_command, {
			cwd: import.meta.dir,
			positionals: ["a", "v1"],
			_test_backend: await seeded_memory(),
		});
		expect((tables(r.output)[0] ?? []).some((row) => row.key === "Parents")).toBe(false);
	});

	it("--observations lists observations in the table and the --json document", async () => {
		const backend = await seeded_memory();
		const put = await backend.observations?.put(note_type, {
			source: { store_id: "a", version: "v1", path: "$.text", span: { start: 1, end: 4 } },
			content: { text: "hi" },
		});
		if (!put?.ok) throw new Error("observation put failed");

		const table = await run(show_command, {
			cwd: import.meta.dir,
			positionals: ["a", "v1"],
			args: { observations: true },
			_test_backend: backend,
		});
		const obs_rows = tables(table.output)[1] ?? [];
		expect(obs_rows.map((o) => [o.id, o.type, o.path, o.span])).toEqual([[put.value.id, "note", "$.text", "1-4"]]);
		expect(lines(table.output)).toEqual([""]);

		const json = await run(show_command, {
			cwd: import.meta.dir,
			positionals: ["a", "v1"],
			args: { observations: true },
			json: true,
			_test_backend: backend,
		});
		const doc = jsons(json.output)[0] as { observations: Array<{ id: string; type: string; source: unknown }> };
		expect(doc.observations.map((o) => [o.id, o.type])).toEqual([[put.value.id, "note"]]);
		expect(doc.observations[0]?.source).toEqual({
			store_id: "a",
			version: "v1",
			path: "$.text",
			span: { start: 1, end: 4 },
		});
		expect(tables(json.output)).toEqual([]);
	});

	it("--observations on a backend without observations prints the note", async () => {
		const backend: Backend = { ...(await seeded_memory()), observations: undefined };
		const r = await run(show_command, {
			cwd: import.meta.dir,
			positionals: ["a", "v1"],
			args: { observations: true },
			_test_backend: backend,
		});
		expect(r.result.ok).toBe(true);
		expect(notes(r.output)).toEqual(["Observations not enabled for this backend"]);
	});
});

describe("stores branches", () => {
	it("a backend without list_stores is invalid_config", async () => {
		const mem = create_memory_backend();
		const backend: Backend = { ...mem, metadata: { ...mem.metadata, list_stores: undefined } };
		const error = failure(await run(stores_command, { cwd: import.meta.dir, _test_backend: backend }));
		expect(error.kind).toBe("invalid_config");
		expect(message_of(error)).toContain("backend does not support store enumeration");
	});

	const failing_backend = (fail: "list" | "list_stores"): Backend => {
		const mem = create_memory_backend();
		const sink = create_error_sink();
		const emit_failure = (operation: string): void => {
			sink.on_event({ type: "error", error: { kind: "storage_error", operation, cause: new Error("db down") } });
		};
		const backend: Backend = {
			...mem,
			metadata: {
				...mem.metadata,
				list_stores: () => {
					if (fail === "list_stores") {
						return empty_listing<string>(() => {
							emit_failure("list_stores");
						});
					}
					return (async function* () {
						await Promise.resolve();
						yield "docs";
					})();
				},
				list: () => {
					return empty_listing<SnapshotMeta>(() => {
						emit_failure("list");
					});
				},
			},
		};
		return track_errors(backend, sink);
	};

	it("surfaces a failing listing instead of an empty table (list_stores and --counts)", async () => {
		for (const [fail, args, operation] of [
			["list_stores", {}, "list_stores"],
			["list", { counts: true }, "list"],
		] as const) {
			const r = await run(stores_command, { cwd: import.meta.dir, args, _test_backend: failing_backend(fail) });
			const error = failure(r);
			expect(error.kind).toBe("storage_error");
			expect(error.kind === "storage_error" && error.operation).toBe(operation);
			expect(tables(r.output)).toEqual([]);
		}
	});

	it("--counts reports counts and the latest created_at per store (table and --json)", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "docs", version: "v1", created_at: new Date("2024-01-01T00:00:00Z") }));
		await seed(backend, make_meta({ store_id: "docs", version: "v2", created_at: new Date("2024-03-01T00:00:00Z") }));

		const table = await run(stores_command, { cwd: import.meta.dir, args: { counts: true }, _test_backend: backend });
		expect(tables(table.output)[0]).toEqual([
			{ id: "docs", version_count: "2", latest_created_at: "2024-03-01T00:00:00.000Z" },
		]);

		const json = await run(stores_command, {
			cwd: import.meta.dir,
			args: { counts: true },
			json: true,
			_test_backend: backend,
		});
		expect(jsons(json.output)).toEqual([
			{ stores: [{ id: "docs", version_count: 2, latest_created_at: "2024-03-01T00:00:00.000Z" }] },
		]);
	});
});

describe("lineage branches", () => {
	it("renders a parent that does not exist as (missing)", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "s", version: "v1", parents: [{ store_id: "ghost", version: "v9" }] }));
		const r = await run(lineage_command, { cwd: import.meta.dir, positionals: ["s", "v1"], _test_backend: backend });
		expect(r.result.ok).toBe(true);
		const out = lines(r.output);
		expect(out[0]).toBe("s/v1");
		expect(out[1]).toContain("ghost/v9 (missing)");
		expect(out).toHaveLength(2);

		const json = await run(lineage_command, {
			cwd: import.meta.dir,
			positionals: ["s", "v1"],
			json: true,
			_test_backend: backend,
		});
		const doc = jsons(json.output)[0] as { nodes: Array<{ store: string; missing?: boolean }> };
		expect(doc.nodes.map((n) => [n.store, n.missing])).toEqual([
			["s", undefined],
			["ghost", true],
		]);
	});

	it("--depth truncates the walk", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "s", version: "v1" }));
		await seed(backend, make_meta({ store_id: "s", version: "v2", parents: [{ store_id: "s", version: "v1" }] }));
		await seed(backend, make_meta({ store_id: "s", version: "v3", parents: [{ store_id: "s", version: "v2" }] }));
		await seed(backend, make_meta({ store_id: "s", version: "v4", parents: [{ store_id: "s", version: "v3" }] }));

		const rendered = async (depth: string): Promise<string[]> =>
			lines(
				(
					await run(lineage_command, {
						cwd: import.meta.dir,
						positionals: ["s", "v4"],
						args: { depth },
						_test_backend: backend,
					})
				).output,
			);

		const shallow = await rendered("1");
		expect(shallow).toHaveLength(2);
		expect(shallow.join("\n")).not.toContain("s/v2");
		expect(await rendered("2")).toHaveLength(3);
		expect(await rendered("10")).toHaveLength(4);
	});

	it("a missing root version is a real error, not a lineage fact", async () => {
		const r = await run(lineage_command, {
			cwd: import.meta.dir,
			positionals: ["s", "v1"],
			_test_backend: create_memory_backend(),
		});
		expect(failure(r).kind).toBe("not_found");
	});

	it("`latest` resolves to the newest version and walks from it", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "s", version: "v1" }));
		await seed(
			backend,
			make_meta({
				store_id: "s",
				version: "v2",
				created_at: new Date("2024-07-01T00:00:00.000Z"),
				parents: [{ store_id: "s", version: "v1" }],
			}),
		);

		const plain = await run(lineage_command, {
			cwd: import.meta.dir,
			positionals: ["s", "latest"],
			_test_backend: backend,
		});
		expect(plain.result.ok).toBe(true);
		const out = lines(plain.output);
		expect(out[0]).toBe("s/v2");
		expect(out[1]).toContain("s/v1");
		expect(out.join("\n")).not.toContain("(missing)");

		const json = await run(lineage_command, {
			cwd: import.meta.dir,
			positionals: ["s", "latest"],
			json: true,
			_test_backend: backend,
		});
		const doc = jsons(json.output)[0] as { root: { store: string; version: string } };
		expect(doc.root).toEqual({ store: "s", version: "v2" });
	});

	it("`latest` on an empty store is the store-level not_found", async () => {
		const error = failure(
			await run(lineage_command, {
				cwd: import.meta.dir,
				positionals: ["ghost", "latest"],
				_test_backend: create_memory_backend(),
			}),
		);
		expect(error).toEqual({ kind: "not_found", store_id: "ghost", version: "", message: "no versions" });
	});
});

describe("cli/lookup.ts", () => {
	it("versions on an empty store is not_found with an empty version and the store-level message", async () => {
		const error = failure(
			await run(versions_command, {
				cwd: import.meta.dir,
				positionals: ["ghost"],
				_test_backend: create_memory_backend(),
			}),
		);
		expect(error).toEqual({ kind: "not_found", store_id: "ghost", version: "", message: "no versions" });
	});

	it("show 'latest' on an empty store is the same store-level not_found", async () => {
		const error = failure(
			await run(show_command, {
				cwd: import.meta.dir,
				positionals: ["ghost", "latest"],
				_test_backend: create_memory_backend(),
			}),
		);
		expect(error).toEqual({ kind: "not_found", store_id: "ghost", version: "", message: "no versions" });
	});

	it("a missing version of an existing store stays a version-level not_found", async () => {
		const backend = create_memory_backend();
		await seed(backend, make_meta({ store_id: "s", version: "v1" }));
		const error = failure(
			await run(show_command, { cwd: import.meta.dir, positionals: ["s", "nope"], _test_backend: backend }),
		);
		expect(error).toMatchObject({ kind: "not_found", store_id: "s", version: "nope" });
	});

	it("ensure_store propagates a non-not_found get_latest error", async () => {
		const mem = create_memory_backend();
		const boom: CorpusError = { kind: "storage_error", operation: "get_latest", cause: new Error("db down") };
		const backend: Backend = { ...mem, metadata: { ...mem.metadata, get_latest: () => Promise.resolve(err(boom)) } };

		const listed = failure(
			await run(versions_command, { cwd: import.meta.dir, positionals: ["s"], _test_backend: backend }),
		);
		expect(listed).toEqual(boom);
		const shown = failure(
			await run(show_command, { cwd: import.meta.dir, positionals: ["s", "latest"], _test_backend: backend }),
		);
		expect(shown).toEqual(boom);
	});

	it("resolve_meta does not mask a non-not_found error from get", async () => {
		const mem = create_memory_backend();
		const boom: CorpusError = { kind: "storage_error", operation: "get", cause: new Error("io") };
		const backend: Backend = { ...mem, metadata: { ...mem.metadata, get: () => Promise.resolve(err(boom)) } };
		expect(
			failure(await run(show_command, { cwd: import.meta.dir, positionals: ["s", "v1"], _test_backend: backend })),
		).toEqual(boom);
	});
});

const make_console = (
	json: boolean,
): { out: string[]; err: string[]; output: ReturnType<typeof create_console_output> } => {
	const out: string[] = [];
	const errs: string[] = [];
	const output = create_console_output({
		json,
		quiet: false,
		stdout_is_tty: false,
		stderr_is_tty: false,
		no_color: true,
		ci: true,
		stdout_write: (chunk) => {
			out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		},
		stderr_write: (chunk) => {
			errs.push(chunk);
		},
	});
	return { out, err: errs, output };
};

const error_doc = z.object({ error: z.object({ kind: z.string(), message: z.string() }) });

describe("cli/output.ts", () => {
	const cause = new Error("root cause");
	const expected: { [K in CorpusError["kind"]]: { error: Extract<CorpusError, { kind: K }>; message: string } } = {
		not_found: {
			error: { kind: "not_found", store_id: "s", version: "v1" },
			message: "Version v1 not found in store s",
		},
		already_exists: {
			error: { kind: "already_exists", store_id: "s", version: "v1" },
			message: "Version v1 already exists in store s",
		},
		storage_error: {
			error: { kind: "storage_error", operation: "put", cause },
			message: "Storage error during put: root cause",
		},
		decode_error: { error: { kind: "decode_error", cause }, message: "Failed to decode data: root cause" },
		encode_error: { error: { kind: "encode_error", cause }, message: "Failed to encode data: root cause" },
		hash_mismatch: {
			error: { kind: "hash_mismatch", expected: "aaa", actual: "bbb" },
			message: "Content hash mismatch (expected aaa, got bbb)",
		},
		invalid_config: { error: { kind: "invalid_config", message: "bad cfg" }, message: "bad cfg" },
		validation_error: {
			error: { kind: "validation_error", message: "bad input", cause },
			message: "Validation failed: bad input",
		},
		observation_not_found: {
			error: { kind: "observation_not_found", id: "obs1" },
			message: "Observation obs1 not found",
		},
		transaction_aborted: {
			error: { kind: "transaction_aborted", reason: "threw", cause },
			message: "Transaction aborted (threw): root cause",
		},
		partial_commit: {
			error: { kind: "partial_commit", ops_completed: 2, ops_failed: 1, cause },
			message: "Partial commit (2 succeeded, 1 failed): root cause",
		},
		concurrent_modification: {
			error: { kind: "concurrent_modification", store_id: "s", version: "v1" },
			message: "Concurrent modification detected in version v1 of store s",
		},
	};

	for (const [kind, { error, message }] of Object.entries(expected)) {
		it(`${kind}: --json error document is prefix-free; plain mode is "error: <message>" on stderr`, () => {
			const json = make_console(true);
			json.output.error(error);
			expect(error_doc.parse(JSON.parse(json.out.join("")))).toEqual({ error: { kind, message } });
			expect(json.err).toEqual([]);

			const plain = make_console(false);
			plain.output.error(error);
			expect(plain.err).toEqual([`error: ${message}\n`]);
			expect(plain.out).toEqual([]);
		});
	}

	it("not_found at store level and with a message", () => {
		const { out, output } = make_console(true);
		output.error({ kind: "not_found", store_id: "s", version: "", message: "no versions" });
		output.error({ kind: "not_found", store_id: "s", version: "v1", message: "gone" });
		expect(out.join("")).toContain(`store \\"s\\" not found (no versions)`);
		expect(out.join("")).toContain("Version v1 not found in store s (gone)");
	});

	it("with_cause appends the innermost cause and truncates long first lines", () => {
		const root = new Error("innermost");
		const wrapper = new Error("wrapper", { cause: root });
		const long = new Error(`${"x".repeat(250)}\nsecond line`);
		const { out, output } = make_console(true);
		output.error({ kind: "decode_error", cause: wrapper });
		output.error({ kind: "decode_error", cause: long });
		const text = out.join("");
		expect(text).toContain("wrapper — caused by: innermost");
		expect(text).toContain(`${"x".repeat(200)}...`);
		expect(text).not.toContain("second line");
	});

	it("string errors: --json is {kind:'error'}, plain goes to stderr verbatim", () => {
		const json = make_console(true);
		json.output.error("plain failure");
		expect(error_doc.parse(JSON.parse(json.out.join("")))).toEqual({
			error: { kind: "error", message: "plain failure" },
		});
		const plain = make_console(false);
		plain.output.error("plain failure");
		expect(plain.err).toEqual(["plain failure\n"]);
	});

	it("write_fatal(error, true) prints message then stack; debug off prints the message only", () => {
		const error = new Error("kaboom");
		const verbose: string[] = [];
		write_fatal(error, true, (chunk) => {
			verbose.push(chunk);
		});
		expect(verbose[0]).toBe("corpus: kaboom\n");
		expect(verbose[1]).toBe(`${error.stack ?? ""}\n`);
		expect(verbose).toHaveLength(2);

		const quiet: string[] = [];
		write_fatal(error, false, (chunk) => {
			quiet.push(chunk);
		});
		expect(quiet).toEqual(["corpus: kaboom\n"]);
	});

	it("write_fatal(non_error, false) prints corpus: <String(value)>; a stackless Error prints no stack", () => {
		const sink: string[] = [];
		const write = (chunk: string): void => {
			sink.push(chunk);
		};
		write_fatal(42, false, write);
		write_fatal({ toString: () => "custom" }, true, write);
		const stackless = new Error("no stack");
		stackless.stack = undefined;
		write_fatal(stackless, true, write);
		expect(sink).toEqual(["corpus: 42\n", "corpus: custom\n", "corpus: no stack\n"]);
	});
});
