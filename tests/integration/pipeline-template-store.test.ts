import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Backend } from "../../index";
import { pipeline_template_store } from "../../index";
import { create_memory_backend } from "../../backend/memory";
import { create_file_backend } from "../../backend/file";

// Minimal schema mirroring the consumer-side shape — corpus is content-agnostic.
const TestTemplateSchema = z.object({
	rollout: z.union([
		z.object({ type: z.literal("atomic") }),
		z.object({
			type: z.literal("gradual"),
			stages: z.array(
				z.object({
					name: z.string(),
					traffic: z.number(),
					bake: z.object({ ms: z.number() }),
				}),
			),
		}),
	]),
	gates: z.record(z.unknown()),
	pre_deploy_checks: z.array(z.object({ kind: z.string(), policy: z.string() })),
	post_deploy_checks: z.array(z.object({ kind: z.string(), policy: z.string() })),
});

type TestTemplate = z.infer<typeof TestTemplateSchema>;

const make_atomic_template = (): TestTemplate => ({
	rollout: { type: "atomic" },
	gates: {},
	pre_deploy_checks: [],
	post_deploy_checks: [],
});

const make_gradual_template = (): TestTemplate => ({
	rollout: {
		type: "gradual",
		stages: [
			{ name: "onebox", traffic: 1, bake: { ms: 60_000 } },
			{ name: "wave1", traffic: 50, bake: { ms: 300_000 } },
			{ name: "full", traffic: 100, bake: { ms: 0 } },
		],
	},
	gates: { "onebox→wave1": { type: "manual" } },
	pre_deploy_checks: [],
	post_deploy_checks: [],
});

type BackendFactory = () => Backend | Promise<Backend>;
type CleanupFn = () => void | Promise<void>;

function run_pipeline_template_tests(name: string, factory: BackendFactory, cleanup?: CleanupFn) {
	describe(`${name} - pipeline_template_store`, () => {
		let backend: Backend;
		let templates: ReturnType<typeof pipeline_template_store<TestTemplate>>;

		beforeEach(async () => {
			if (cleanup) await cleanup();
			backend = await factory();
			templates = pipeline_template_store(backend, TestTemplateSchema);
		});

		describe("put", () => {
			it("stores a template and returns SnapshotMeta", async () => {
				const result = await templates.put(make_atomic_template());

				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.value.store_id).toBe("pipeline-templates");
				expect(result.value.version).toBeString();
				expect(result.value.content_hash).toBeString();
			});

			it("lays out data_key as <store_id>/<content_hash> (no per-package partition)", async () => {
				const put = await templates.put(make_atomic_template());
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				expect(put.value.data_key).toBe(`pipeline-templates/${put.value.content_hash}`);
			});

			it("dedupes identical templates via content hash", async () => {
				const tmpl = make_gradual_template();
				const a = await templates.put(tmpl);
				const b = await templates.put(tmpl);

				expect(a.ok && b.ok).toBe(true);
				if (!a.ok || !b.ok) return;

				expect(a.value.content_hash).toBe(b.value.content_hash);
				expect(a.value.data_key).toBe(b.value.data_key);
				// distinct versions — content shared, snapshot meta separate
				expect(a.value.version).not.toBe(b.value.version);
			});

			it("hashes different template shapes to different keys", async () => {
				const a = await templates.put(make_atomic_template());
				const b = await templates.put(make_gradual_template());

				expect(a.ok && b.ok).toBe(true);
				if (!a.ok || !b.ok) return;
				expect(a.value.content_hash).not.toBe(b.value.content_hash);
			});
		});

		describe("get", () => {
			it("round-trips an atomic template body", async () => {
				const template = make_atomic_template();
				const put = await templates.put(template);
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				const got = await templates.get(put.value.version);
				expect(got.ok).toBe(true);
				if (!got.ok) return;
				expect(got.value.data).toEqual(template);
			});

			it("round-trips a gradual template body", async () => {
				const template = make_gradual_template();
				const put = await templates.put(template);
				expect(put.ok).toBe(true);
				if (!put.ok) return;

				const got = await templates.get(put.value.version);
				expect(got.ok).toBe(true);
				if (!got.ok) return;
				expect(got.value.data).toEqual(template);
			});

			it("returns not_found for an unknown version", async () => {
				const got = await templates.get("does-not-exist");
				expect(got.ok).toBe(false);
				if (got.ok) return;
				expect(got.error.kind).toBe("not_found");
			});
		});
	});
}

run_pipeline_template_tests("MemoryBackend", () => create_memory_backend());

const fileTestDir = join(tmpdir(), "corpus-pipeline-template-test-file");
run_pipeline_template_tests(
	"FileBackend",
	async () => {
		await rm(fileTestDir, { recursive: true, force: true });
		await mkdir(fileTestDir, { recursive: true });
		return create_file_backend({ base_path: fileTestDir });
	},
	async () => {
		await rm(fileTestDir, { recursive: true, force: true });
	},
);

afterAll(async () => {
	await rm(fileTestDir, { recursive: true, force: true });
});
