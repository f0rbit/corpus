import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { create_file_backend } from "../../backend/file.js";
import { define_observation_type, create_pointer } from "../../observations/index.js";
import type { ObservationsClient } from "../../types";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".test-file-observations");

const sentiment_type = define_observation_type(
	"sentiment",
	z.object({
		subject: z.string(),
		score: z.number().min(-1).max(1),
		keywords: z.array(z.string()),
	}),
);

const entity_type = define_observation_type(
	"entity",
	z.object({
		name: z.string(),
		type: z.enum(["person", "org", "location"]),
		mentions: z.number(),
	}),
);

const simple_type = define_observation_type(
	"simple",
	z.object({
		value: z.string(),
	}),
);

describe("observations integration - file backend", () => {
	let backend: ReturnType<typeof create_file_backend>;
	let observations: ObservationsClient;

	beforeEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
		backend = create_file_backend({ base_path: TEST_DIR });
		observations = backend.observations!;
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	describe("basic CRUD", () => {
		it("puts and gets an observation", async () => {
			const result = await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				content: { subject: "test", score: 0.8, keywords: ["good"] },
			});

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const obs = result.value;
			expect(obs.type).toBe("sentiment");
			expect(obs.content.subject).toBe("test");
			expect(obs.content.score).toBe(0.8);
			expect(obs.source.store_id).toBe("docs");
			expect(obs.source.version).toBe("v1");
			expect(obs.id).toMatch(/^obs_/);

			const get_result = await observations.get(obs.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.id).toBe(obs.id);
			}
		});

		it("returns observation_not_found for missing id", async () => {
			const result = await observations.get("nonexistent");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("observation_not_found");
			}
		});

		it("deletes an observation", async () => {
			const put_result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "test" },
			});
			expect(put_result.ok).toBe(true);
			if (!put_result.ok) return;

			const delete_result = await observations.delete(put_result.value.id);
			expect(delete_result.ok).toBe(true);

			const get_result = await observations.get(put_result.value.id);
			expect(get_result.ok).toBe(false);
		});

		it("delete returns not_found for missing id", async () => {
			const result = await observations.delete("nonexistent");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("observation_not_found");
			}
		});

		it("delete_by_source removes matching observations", async () => {
			const source = create_pointer("docs", "v1");
			await observations.put(simple_type, { source, content: { value: "a" } });
			await observations.put(simple_type, { source, content: { value: "b" } });
			await observations.put(simple_type, {
				source: create_pointer("docs", "v2"),
				content: { value: "c" },
			});

			const delete_result = await observations.delete_by_source(source);
			expect(delete_result.ok).toBe(true);
			if (delete_result.ok) {
				expect(delete_result.value).toBe(2);
			}

			const remaining = await Array.fromAsync(observations.query({}));
			expect(remaining.length).toBe(1);
		});

		it("delete_by_source returns 0 for no matches", async () => {
			const result = await observations.delete_by_source(create_pointer("nonexistent", "v1"));
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(0);
			}
		});

		it("delete_by_source respects path filter", async () => {
			const base = create_pointer("docs", "v1");
			const with_path = create_pointer("docs", "v1", "$.specific");

			await observations.put(simple_type, { source: base, content: { value: "a" } });
			await observations.put(simple_type, { source: with_path, content: { value: "b" } });

			const delete_result = await observations.delete_by_source(with_path);
			expect(delete_result.ok).toBe(true);
			if (delete_result.ok) {
				expect(delete_result.value).toBe(1);
			}

			const remaining = await Array.fromAsync(observations.query({}));
			expect(remaining.length).toBe(1);
		});
	});

	describe("type validation", () => {
		it("validates content against schema on put", async () => {
			const result = await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				content: { subject: "test", score: 0.5, keywords: ["word"] },
			});
			expect(result.ok).toBe(true);
		});

		it("rejects invalid content - missing field", async () => {
			const result = await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				// @ts-expect-error - testing invalid content
				content: { subject: "test" },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("validation_error");
			}
		});

		it("rejects invalid content - wrong type", async () => {
			const result = await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				// @ts-expect-error - testing invalid content
				content: { subject: 123, score: "bad", keywords: "not-array" },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("validation_error");
			}
		});

		it("rejects invalid content - out of range", async () => {
			const result = await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				content: { subject: "test", score: 5.0, keywords: [] },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("validation_error");
			}
		});
	});

	describe("query filtering", () => {
		beforeEach(async () => {
			await observations.put(sentiment_type, {
				source: create_pointer("docs", "v1"),
				content: { subject: "topic1", score: 0.8, keywords: ["good"] },
				observed_at: new Date("2024-01-15"),
			});
			await observations.put(sentiment_type, {
				source: create_pointer("docs", "v2"),
				content: { subject: "topic2", score: -0.5, keywords: ["bad"] },
				observed_at: new Date("2024-02-15"),
			});
			await observations.put(entity_type, {
				source: create_pointer("articles", "a1"),
				content: { name: "Acme Corp", type: "org", mentions: 5 },
				observed_at: new Date("2024-01-20"),
			});
		});

		it("filters by type", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ type: "sentiment" })) {
				results.push(obs);
			}
			expect(results.length).toBe(2);
		});

		it("filters by multiple types", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ type: ["sentiment", "entity"] })) {
				results.push(obs);
			}
			expect(results.length).toBe(3);
		});

		it("filters by source_store", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ source_store: "docs" })) {
				results.push(obs);
			}
			expect(results.length).toBe(2);
		});

		it("filters by source_version", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ source_version: "v1" })) {
				results.push(obs);
			}
			expect(results.length).toBe(1);
		});

		it("filters by source_prefix", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ source_prefix: "v" })) {
				results.push(obs);
			}
			expect(results.length).toBe(2);
		});

		it("filters by observed_at range - after only", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({
				after: new Date("2024-01-20"),
			})) {
				results.push(obs);
			}
			expect(results.length).toBe(1);
		});

		it("filters by observed_at range - before only", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({
				before: new Date("2024-01-20"),
			})) {
				results.push(obs);
			}
			expect(results.length).toBe(1);
		});

		it("respects limit", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ limit: 1 })) {
				results.push(obs);
			}
			expect(results.length).toBe(1);
		});

		it("query_meta excludes content", async () => {
			for await (const meta of observations.query_meta({ type: "sentiment" })) {
				expect(meta.id).toBeDefined();
				expect(meta.type).toBe("sentiment");
				expect(meta).not.toHaveProperty("content");
			}
		});
	});

	describe("optional fields", () => {
		it("stores and retrieves confidence", async () => {
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "test" },
				confidence: 0.95,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.confidence).toBe(0.95);
			}
		});

		it("stores and retrieves observed_at", async () => {
			const observed_at = new Date("2024-06-15T10:30:00Z");
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "test" },
				observed_at,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.observed_at?.toISOString()).toBe(observed_at.toISOString());
			}
		});

		it("stores and retrieves derived_from", async () => {
			const derived_from = [create_pointer("models", "gpt4"), create_pointer("prompts", "sentiment-v2")];
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "test" },
				derived_from,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.derived_from).toEqual(derived_from);
			}
		});

		it("stores source with path", async () => {
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1", "$.paragraphs[0]"),
				content: { value: "test" },
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.source.path).toBe("$.paragraphs[0]");
			}
		});

		it("stores source with span", async () => {
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1", undefined, { start: 100, end: 200 }),
				content: { value: "test" },
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.source.span).toEqual({ start: 100, end: 200 });
			}
		});
	});

	describe("staleness detection", () => {
		it("is_stale returns false when no snapshots exist", async () => {
			const pointer = create_pointer("docs", "v1");
			const stale = await observations.is_stale(pointer);
			expect(stale).toBe(false);
		});

		it("is_stale returns false when pointing to latest version", async () => {
			await backend.metadata.put({
				store_id: "docs",
				version: "v1",
				parents: [],
				created_at: new Date(),
				content_hash: "hash1",
				content_type: "application/json",
				size_bytes: 100,
				data_key: "docs/hash1",
			});

			const pointer = create_pointer("docs", "v1");
			const stale = await observations.is_stale(pointer);
			expect(stale).toBe(false);
		});

		it("is_stale returns true when newer version exists", async () => {
			await backend.metadata.put({
				store_id: "docs",
				version: "v1",
				parents: [],
				created_at: new Date("2024-01-01"),
				content_hash: "hash1",
				content_type: "application/json",
				size_bytes: 100,
				data_key: "docs/hash1",
			});

			await backend.metadata.put({
				store_id: "docs",
				version: "v2",
				parents: [],
				created_at: new Date("2024-01-02"),
				content_hash: "hash2",
				content_type: "application/json",
				size_bytes: 100,
				data_key: "docs/hash2",
			});

			const pointer = create_pointer("docs", "v1");
			const stale = await observations.is_stale(pointer);
			expect(stale).toBe(true);
		});
	});

	describe("version_filter", () => {
		beforeEach(async () => {
			await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "first" },
			});
			await observations.put(simple_type, {
				source: create_pointer("docs", "v2"),
				content: { value: "second" },
			});
			await observations.put(simple_type, {
				source: create_pointer("docs", "v3"),
				content: { value: "third" },
			});
		});

		it("filters with Set<string>", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ version_filter: new Set(["v1", "v3"]) })) {
				results.push(obs);
			}
			expect(results.length).toBe(2);
		});

		it("filters with string[]", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({ version_filter: ["v2"] })) {
				results.push(obs);
			}
			expect(results.length).toBe(1);
		});

		it("filters with function", async () => {
			const results: unknown[] = [];
			for await (const obs of observations.query({
				version_filter: (_store_id, version) => version !== "v2",
			})) {
				results.push(obs);
			}
			expect(results.length).toBe(2);
		});
	});

	describe("persistence", () => {
		it("persists observations across backend instances", async () => {
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "persistent" },
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const obs_id = result.value.id;

			const new_backend = create_file_backend({ base_path: TEST_DIR });
			const new_observations = new_backend.observations!;

			const get_result = await new_observations.get(obs_id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.content).toEqual({ value: "persistent" });
			}
		});

		it("persists multiple observations", async () => {
			await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "a" },
			});
			await observations.put(simple_type, {
				source: create_pointer("docs", "v2"),
				content: { value: "b" },
			});

			const new_backend = create_file_backend({ base_path: TEST_DIR });
			const new_observations = new_backend.observations!;

			const remaining = await Array.fromAsync(new_observations.query({}));
			expect(remaining.length).toBe(2);
		});
	});

	describe("timestamps", () => {
		it("sets created_at automatically", async () => {
			const before = new Date();
			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content: { value: "test" },
			});
			const after = new Date();

			expect(result.ok).toBe(true);
			if (!result.ok) return;

			expect(result.value.created_at).toBeInstanceOf(Date);
			expect(result.value.created_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
			expect(result.value.created_at.getTime()).toBeLessThanOrEqual(after.getTime());
		});
	});

	describe("content retrieval", () => {
		it("preserves complex nested content", async () => {
			const complex_type = define_observation_type(
				"complex",
				z.object({
					nested: z.object({
						array: z.array(
							z.object({
								key: z.string(),
								values: z.array(z.number()),
							}),
						),
						optional: z.string().optional(),
					}),
				}),
			);

			const content = {
				nested: {
					array: [
						{ key: "a", values: [1, 2, 3] },
						{ key: "b", values: [4, 5] },
					],
					optional: "present",
				},
			};

			const result = await observations.put(complex_type, {
				source: create_pointer("docs", "v1"),
				content,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.content).toEqual(content);
			}
		});

		it("handles special characters in content", async () => {
			const content = { value: 'test with "quotes" and \\backslash and unicode: 日本語' };

			const result = await observations.put(simple_type, {
				source: create_pointer("docs", "v1"),
				content,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const get_result = await observations.get(result.value.id);
			expect(get_result.ok).toBe(true);
			if (get_result.ok) {
				expect(get_result.value.content).toEqual(content);
			}
		});
	});
});
