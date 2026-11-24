import { describe, it, expect } from "bun:test";
import { z } from "zod";
import * as testing from "../../testing/index.js";
import {
	define_observation_type,
	create_pointer,
	pointer_to_key,
	key_to_pointer,
	resolve_path,
	apply_span,
	generate_observation_id,
	pointers_equal,
	pointer_to_snapshot,
} from "../../observations/index.js";
import type { SnapshotPointer } from "../../observations/index.js";

const fc = testing.fc;

const id_arb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,8}$/);
const path_arb = fc
	.array(fc.stringMatching(/^[a-z$][a-z0-9.$]{0,6}$/), { minLength: 1, maxLength: 3 })
	.map((segments) => segments.join(":"));
const span_arb = fc.record({ start: fc.nat(1000), end: fc.nat(1000) });

const pointer_arb = fc
	.tuple(id_arb, id_arb, fc.option(path_arb, { nil: undefined }), fc.option(span_arb, { nil: undefined }))
	.map(([store_id, version, path, span]) => create_pointer(store_id, version, path, span));

const full_pointer_arb = fc
	.tuple(id_arb, id_arb, path_arb, span_arb)
	.map(([store_id, version, path, span]) => create_pointer(store_id, version, path, span));

const small_pointer_arb = fc
	.tuple(
		fc.constantFrom("a", "b"),
		fc.constantFrom("1", "2"),
		fc.option(fc.constantFrom("$.x", "$.y"), { nil: undefined }),
		fc.option(fc.record({ start: fc.nat(2), end: fc.nat(2) }), { nil: undefined }),
	)
	.map(([store_id, version, path, span]) => create_pointer(store_id, version, path, span));

const parse_key = (key: string): SnapshotPointer => {
	const pointer = key_to_pointer(key);
	if (pointer === null) throw new Error(`key did not parse: ${key}`);
	return pointer;
};

const safe_key = /^[a-z][a-z0-9_]*$/;

type Step = { path: string; node: unknown };

const walk = (node: unknown, path: string, picks: readonly number[]): Step => {
	const [pick, ...rest] = picks;
	if (pick === undefined) return { path, node };
	if (Array.isArray(node)) {
		if (node.length === 0) return { path, node };
		const index = pick % node.length;
		const child: unknown = node[index];
		return walk(child, `${path}[${String(index)}]`, rest);
	}
	if (node === null || typeof node !== "object") return { path, node };
	const entries: [string, unknown][] = Object.entries(node).filter(([key]) => safe_key.test(key));
	const entry = entries[pick % Math.max(entries.length, 1)];
	if (entry === undefined) return { path, node };
	return walk(entry[1], `${path}.${entry[0]}`, rest);
};

const picks_arb = fc.array(fc.nat(), { maxLength: 6 });

const is_object = (node: unknown): boolean => typeof node === "object" && node !== null;

describe("define_observation_type", () => {
	it("creates type definition with name and schema", () => {
		const schema = z.object({ text: z.string() });
		const type = define_observation_type("test-type", schema);

		expect(type.name).toBe("test-type");
		expect(type.schema).toBe(schema);
	});

	it("preserves generic type inference", () => {
		const type = define_observation_type(
			"typed",
			z.object({
				name: z.string(),
				value: z.number(),
			}),
		);

		const result = type.schema.parse({ name: "test", value: 42 });
		expect(result.name).toBe("test");
		expect(result.value).toBe(42);
	});
});

describe("create_pointer", () => {
	it("sets only the keys that were provided", () => {
		fc.assert(
			fc.property(
				id_arb,
				id_arb,
				fc.option(path_arb, { nil: undefined }),
				fc.option(span_arb, { nil: undefined }),
				(store_id, version, path, span) => {
					const pointer = create_pointer(store_id, version, path, span);
					const expected = [
						"store_id",
						"version",
						...(path === undefined ? [] : ["path"]),
						...(span === undefined ? [] : ["span"]),
					];
					expect(Object.keys(pointer).toSorted()).toEqual(expected.toSorted());
					expect(pointer.store_id).toBe(store_id);
					expect(pointer.version).toBe(version);
					expect(pointer.path).toBe(path);
					expect(pointer.span).toEqual(span);
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("pointer keys", () => {
	it("key_to_pointer inverts pointer_to_key (paths contain ':' and '.', spans optional)", async () => {
		await testing.law.round_trip(pointer_arb, pointer_to_key, parse_key, { numRuns: 300 });
	});

	it("round-trips pointers that always carry a path and a span", async () => {
		await testing.law.round_trip(full_pointer_arb, pointer_to_key, parse_key, { numRuns: 200 });
	});

	it("serialises as store:version[:path][:start-end]", () => {
		fc.assert(
			fc.property(pointer_arb, (pointer) => {
				const expected = [
					pointer.store_id,
					pointer.version,
					...(pointer.path === undefined ? [] : [pointer.path]),
					...(pointer.span === undefined ? [] : [`${String(pointer.span.start)}-${String(pointer.span.end)}`]),
				].join(":");
				expect(pointer_to_key(pointer)).toBe(expected);
			}),
			{ numRuns: 200 },
		);
	});

	it("key_to_pointer returns null for keys without a colon", () => {
		fc.assert(
			fc.property(
				fc.string().filter((s) => !s.includes(":")),
				(key) => {
					expect(key_to_pointer(key)).toBeNull();
				},
			),
			{ numRuns: 100 },
		);
	});

	it("key_to_pointer returns null for an empty store_id or version", () => {
		fc.assert(
			fc.property(id_arb, id_arb, fc.string(), (store_id, version, rest) => {
				expect(key_to_pointer(`:${version}:${rest}`)).toBeNull();
				expect(key_to_pointer(`:${version}`)).toBeNull();
				expect(key_to_pointer(`${store_id}:`)).toBeNull();
				expect(key_to_pointer(`${store_id}::${rest}`)).toBeNull();
			}),
			{ numRuns: 100 },
		);
	});
});

describe("resolve_path", () => {
	it("empty path and $ resolve to the root", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				for (const path of ["", "$"]) {
					const result = resolve_path(value, path);
					expect(result.ok).toBe(true);
					if (result.ok) expect(result.value).toBe(value);
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("a path built from a real walk resolves to the leaf", () => {
		fc.assert(
			fc.property(fc.jsonValue(), picks_arb, (value, picks) => {
				const { path, node } = walk(value, "$", picks);
				const result = resolve_path(value, path);
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value).toBe(node);

				const bare = path.startsWith("$.") ? path.slice(2) : path;
				const bare_result = resolve_path(value, bare);
				expect(bare_result.ok).toBe(true);
				if (bare_result.ok) expect(bare_result.value).toBe(node);
			}),
			{ numRuns: 300 },
		);
	});

	it("a missing property under an object resolves to undefined", () => {
		fc.assert(
			fc.property(fc.jsonValue(), picks_arb, (value, picks) => {
				const { path, node } = walk(value, "$", picks);
				if (typeof node !== "object" || node === null || "zz_missing" in node) return;
				const result = resolve_path(value, `${path}.zz_missing`);
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value).toBeUndefined();
			}),
			{ numRuns: 300 },
		);
	});

	it("traversing through null, undefined or a primitive is not_found", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<unknown>(null, undefined, 0, 42, "text", "", true, false),
				fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/),
				(node, key) => {
					const result = resolve_path({ leaf: node }, `$.leaf.${key}`);
					expect(result.ok).toBe(false);
					if (!result.ok) expect(result.error.kind).toBe("not_found");
				},
			),
			{ numRuns: 100 },
		);
	});

	it("a walk that ends on a non-object cannot be extended", () => {
		fc.assert(
			fc.property(fc.jsonValue(), picks_arb, (value, picks) => {
				const { path, node } = walk(value, "$", picks);
				if (is_object(node)) return;
				const result = resolve_path(value, `${path}.zz_missing`);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.kind).toBe("not_found");
			}),
			{ numRuns: 300 },
		);
	});
});

describe("apply_span", () => {
	const span_case_arb = fc
		.string({ maxLength: 20 })
		.chain((text) =>
			fc.tuple(
				fc.constant(text),
				fc.integer({ min: -3, max: text.length + 3 }),
				fc.integer({ min: -3, max: text.length + 3 }),
			),
		);

	it("is ok(slice) exactly when 0 <= start <= end <= length", () => {
		fc.assert(
			fc.property(span_case_arb, ([text, start, end]) => {
				const result = apply_span(text, { start, end });
				const valid = start >= 0 && start <= end && end <= text.length;
				expect(result.ok).toBe(valid);
				if (result.ok) expect(result.value).toBe(text.slice(start, end));
				if (!result.ok) expect(result.error.kind).toBe("validation_error");
			}),
			{ numRuns: 500 },
		);
	});

	it("the full span returns the whole string", () => {
		fc.assert(
			fc.property(fc.string(), (text) => {
				const result = apply_span(text, { start: 0, end: text.length });
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value).toBe(text);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("pointers_equal", () => {
	it("is reflexive over copies", () => {
		fc.assert(
			fc.property(pointer_arb, (pointer) => {
				const copy = create_pointer(
					pointer.store_id,
					pointer.version,
					pointer.path,
					pointer.span && { ...pointer.span },
				);
				expect(pointers_equal(pointer, copy)).toBe(true);
			}),
			{ numRuns: 100 },
		);
	});

	it("is symmetric and true exactly when every field matches", () => {
		fc.assert(
			fc.property(
				small_pointer_arb,
				small_pointer_arb,
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(a, other, use_store, use_version, use_path, use_span) => {
					const b = create_pointer(
						use_store ? a.store_id : other.store_id,
						use_version ? a.version : other.version,
						use_path ? a.path : other.path,
						use_span ? a.span : other.span,
					);
					const expected = Bun.deepEquals(a, b, true);
					expect(pointers_equal(a, b)).toBe(expected);
					expect(pointers_equal(b, a)).toBe(expected);
				},
			),
			{ numRuns: 500 },
		);
	});

	it("distinguishes presence from absence of a path and span, and each span bound", () => {
		fc.assert(
			fc.property(pointer_arb, (pointer) => {
				const with_path = { ...pointer, path: "$.p" };
				const without_path = create_pointer(pointer.store_id, pointer.version, undefined, pointer.span);
				expect(pointers_equal(with_path, without_path)).toBe(false);

				const span = { start: 3, end: 9 };
				const base = create_pointer(pointer.store_id, pointer.version, pointer.path, span);
				expect(pointers_equal(base, create_pointer(base.store_id, base.version, base.path))).toBe(false);
				expect(pointers_equal(base, { ...base, span: { start: 4, end: 9 } })).toBe(false);
				expect(pointers_equal(base, { ...base, span: { start: 3, end: 10 } })).toBe(false);
				expect(pointers_equal(base, { ...base, span: { ...span } })).toBe(true);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("pointer_to_snapshot", () => {
	it("keeps store_id and version, strips path and span, returns a new object", () => {
		fc.assert(
			fc.property(pointer_arb, (pointer) => {
				const snapshot = pointer_to_snapshot(pointer);
				expect(Object.keys(snapshot).toSorted()).toEqual(["store_id", "version"]);
				expect(snapshot.store_id).toBe(pointer.store_id);
				expect(snapshot.version).toBe(pointer.version);
				expect(snapshot).not.toBe(pointer);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("generate_observation_id", () => {
	it("generates unique ids", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generate_observation_id());
		}
		expect(ids.size).toBe(100);
	});

	it("has the obs_{timestamp}_{random} format", () => {
		const id = generate_observation_id();
		expect(id).toMatch(/^obs_[0-9a-z]+_[0-9a-z]+$/);
		expect(id.split("_").length).toBe(3);
	});
});
