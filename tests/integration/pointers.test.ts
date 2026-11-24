/**
 * `corpus.resolve_pointer` / `corpus.is_superseded` — the instance methods
 * (store lookup, JSONPath, span slicing, staleness via the observations client).
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { create_corpus, create_memory_backend, define_store, json_codec, text_codec } from "../../index.js";
import { define_observation_type } from "../../observations/index.js";
import type { CorpusError, Result } from "../../types.js";

const doc_schema = z.object({ title: z.string(), n: z.number(), tags: z.array(z.string()) });
const docs = define_store("docs", json_codec(doc_schema));
const raw = define_store("raw", text_codec());
const marker = define_observation_type("marker", z.object({ label: z.string() }));

const doc = { title: "hello world", n: 7, tags: ["a", "b"] };

function build() {
	return create_corpus().with_backend(create_memory_backend()).with_store(docs).with_store(raw).build();
}

function value_of<T>(result: Result<T, CorpusError>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
	return result.value;
}

function error_of(result: Result<unknown, CorpusError>): CorpusError {
	if (result.ok) throw new Error("expected err, got ok");
	return result.error;
}

describe("resolve_pointer", () => {
	it("is not_found for an unknown store", async () => {
		const corpus = build();
		const error = error_of(await corpus.resolve_pointer(corpus.create_pointer("nope", "v1")));
		expect(error).toMatchObject({ kind: "not_found", store_id: "nope", version: "v1" });
	});

	it("is not_found for an unknown version", async () => {
		const corpus = build();
		const error = error_of(await corpus.resolve_pointer(corpus.create_pointer("docs", "missing")));
		expect(error).toMatchObject({ kind: "not_found", store_id: "docs", version: "missing" });
	});

	it("returns the whole value for a bare pointer", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.docs.put(doc));
		expect(value_of(await corpus.resolve_pointer<unknown>(corpus.create_pointer("docs", version)))).toEqual(doc);
	});

	it("resolves a path to the value at that location", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.docs.put(doc));
		const tag = await corpus.resolve_pointer<string>(corpus.create_pointer("docs", version, "$.tags[1]"));
		expect(value_of(tag)).toBe("b");
		const n = await corpus.resolve_pointer<number>(corpus.create_pointer("docs", version, "$.n"));
		expect(value_of(n)).toBe(7);
	});

	it("returns the resolve_path error when the path walks through a primitive", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.docs.put(doc));
		const error = error_of(await corpus.resolve_pointer(corpus.create_pointer("docs", version, "$.title.deeper")));
		expect(error.kind).toBe("not_found");
		expect("message" in error ? error.message : "").toContain("not an object");
	});

	it("slices a string value by span", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.raw.put("hello world"));
		const pointer = corpus.create_pointer("raw", version, undefined, { start: 6, end: 11 });
		expect(value_of(await corpus.resolve_pointer<string>(pointer))).toBe("world");
	});

	it("applies a span to the string a path resolved to", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.docs.put(doc));
		const pointer = corpus.create_pointer("docs", version, "$.title", { start: 0, end: 5 });
		expect(value_of(await corpus.resolve_pointer<string>(pointer))).toBe("hello");
	});

	it("returns the apply_span error for an out-of-range span", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.raw.put("short"));
		const pointer = corpus.create_pointer("raw", version, undefined, { start: 0, end: 99 });
		const error = error_of(await corpus.resolve_pointer(pointer));
		expect(error.kind).toBe("validation_error");
		expect("message" in error ? error.message : "").toContain("Invalid span");
	});

	it("ignores a span on a non-string value", async () => {
		const corpus = build();
		const { version } = value_of(await corpus.stores.docs.put(doc));
		const whole = corpus.create_pointer("docs", version, undefined, { start: 0, end: 999 });
		expect(value_of(await corpus.resolve_pointer<unknown>(whole))).toEqual(doc);
		const number = corpus.create_pointer("docs", version, "$.n", { start: 0, end: 999 });
		expect(value_of(await corpus.resolve_pointer<number>(number))).toBe(7);
	});
});

describe("is_superseded", () => {
	it("is false when the corpus has no observations configured", async () => {
		const corpus = build();
		const older = value_of(await corpus.stores.raw.put("one"));
		value_of(await corpus.stores.raw.put("two"));
		expect(await corpus.is_superseded(corpus.create_pointer("raw", older.version))).toBe(false);
	});

	it("is true for an older version and false for the latest", async () => {
		const corpus = create_corpus()
			.with_backend(create_memory_backend())
			.with_store(raw)
			.with_observations([marker])
			.build();
		const older = value_of(await corpus.stores.raw.put("one"));
		const latest = value_of(await corpus.stores.raw.put("two"));
		expect(await corpus.is_superseded(corpus.create_pointer("raw", older.version))).toBe(true);
		expect(await corpus.is_superseded(corpus.create_pointer("raw", latest.version))).toBe(false);
	});
});
