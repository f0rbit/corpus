import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	text_codec,
	define_observation_type,
	type Corpus,
	type Store,
} from "../../index.js";

const item_schema = z.object({ id: z.string() });
type Item = z.infer<typeof item_schema>;

describe("immutable type-state builder", () => {
	it("has no build until a backend is configured", () => {
		// @ts-expect-error build does not exist before with_backend
		expect(typeof create_corpus().build).toBe("function");
		// @ts-expect-error stores added without a backend still cannot build
		expect(typeof create_corpus().with_store(define_store("n", text_codec())).build).toBe("function");
	});

	it("untyped build() without a backend still throws", () => {
		const untyped = create_corpus() as unknown as { build: () => unknown };
		expect(() => untyped.build()).toThrow("without a backend");
	});

	it("infers store types when with_store precedes with_backend", async () => {
		const corpus: Corpus<{ items: Store<Item>; notes: Store<string> }> = create_corpus()
			.with_store(define_store("items", json_codec(item_schema)))
			.with_backend(create_memory_backend())
			.with_store(define_store("notes", text_codec()))
			.build();

		const put = await corpus.stores.items.put({ id: "a" });
		expect(put.ok).toBe(true);
		const note = await corpus.stores.notes.put("hi");
		expect(note.ok).toBe(true);
	});

	it("branches from one base do not see each other's stores", () => {
		const base = create_corpus().with_backend(create_memory_backend());
		const a = base.with_store(define_store("a", text_codec()));
		const b = base.with_store(define_store("b", text_codec()));

		const corpus_a = a.build();
		const corpus_b = b.build();
		const corpus_base = base.build();

		expect(Object.keys(corpus_a.stores)).toEqual(["a"]);
		expect(Object.keys(corpus_b.stores)).toEqual(["b"]);
		expect(Object.keys(corpus_base.stores)).toEqual([]);
	});

	it("a later with_backend does not mutate earlier builders", () => {
		const base = create_corpus().with_store(define_store("a", text_codec()));
		const first = base.with_backend(create_memory_backend());
		const second = first.with_store(define_store("b", text_codec()));

		expect(Object.keys(first.build().stores)).toEqual(["a"]);
		expect(Object.keys(second.build().stores)).toEqual(["a", "b"]);
	});

	it("with_observations is order-independent relative to with_backend", () => {
		const note_type = define_observation_type("note", z.object({ text: z.string() }));
		const before = create_corpus()
			.with_observations([note_type])
			.with_backend(create_memory_backend())
			.with_store(define_store("a", text_codec()))
			.build();
		const after = create_corpus()
			.with_backend(create_memory_backend())
			.with_store(define_store("a", text_codec()))
			.with_observations([note_type])
			.build();

		expect(Object.keys(before.stores)).toEqual(Object.keys(after.stores));
		expect(typeof before.observations).toBe(typeof after.observations);
	});
});
