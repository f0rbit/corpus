/**
 * @module tests/property/result-laws
 * @description Law-style properties for result.ts combinators: match/unwrap family, try_catch,
 * pipe vs standalone equivalence, null_on/fallback_on, format_error, merge_deep, at/first/last.
 * `unwrap`/`unwrap_err` throwing and `fetch_result` stay example-based in tests/unit/result.test.ts.
 */

import { describe, test, expect } from "bun:test";
import * as testing from "../../testing/index.js";
import {
	match,
	unwrap_or,
	unwrap,
	unwrap_err,
	try_catch,
	try_catch_async,
	pipe,
	to_nullable,
	to_fallback,
	null_on,
	fallback_on,
	format_error,
	merge_deep,
	at,
	first,
	last,
} from "../../result.js";
import { ok, err, type Result } from "../../types.js";

const fc = testing.fc;

type R = Result<unknown, unknown>;
type Tagged = { tag: "ok"; value: unknown } | { tag: "err"; error: unknown };

const result_arb = fc.oneof(
	fc.anything().map((v): R => ok(v)),
	fc.anything().map((v): R => err(v)),
);

const thrown_arb = fc.oneof(
	fc.string(),
	fc.integer(),
	fc.double(),
	fc.boolean(),
	fc.constant(null),
	fc.constant(undefined),
	fc.bigInt(),
	fc.array(fc.integer()),
	fc.constant({ code: 500 }),
	fc.string().map((m) => new Error(m)),
	fc.string().map((m) => new TypeError(m)),
);

const payload = (r: R): unknown => (r.ok ? r.value : r.error);

const same = (actual: R, expected: R): void => {
	expect(actual.ok).toBe(expected.ok);
	expect(payload(actual)).toEqual(payload(expected));
};

const raise = (x: unknown): never => {
	throw x;
};

const reject_with = (x: unknown): Promise<never> => Promise.resolve().then(() => raise(x));

const caught = (fn: () => unknown): { threw: boolean; value: unknown } => {
	try {
		return { threw: false, value: fn() };
	} catch (e) {
		return { threw: true, value: e };
	}
};

const stringify: (x: unknown) => string = String;

const recording_predicate = (verdict: boolean) => {
	const seen: unknown[] = [];
	return {
		seen,
		pred: (e: unknown): boolean => {
			seen.push(e);
			return verdict;
		},
	};
};

const expect_err = <E>(r: Result<unknown, E>): E => {
	if (r.ok) throw new Error("expected err result");
	return r.error;
};

const expect_ok = <T>(r: Result<T, unknown>): T => {
	if (!r.ok) throw new Error("expected ok result");
	return r.value;
};

const key_arb = fc.constantFrom("a", "b", "c");
const leaf_arb = fc.oneof(
	fc.integer(),
	fc.string(),
	fc.boolean(),
	fc.constant(null),
	fc.array(fc.integer(), { minLength: 1, maxLength: 3 }),
);
const { node: node_arb, obj: tree_arb } = fc.letrec<{ node: unknown; obj: Record<string, unknown> }>((tie) => ({
	node: fc.oneof({ depthSize: "small", maxDepth: 3 }, leaf_arb, tie("obj")),
	obj: fc.dictionary(key_arb, tie("node")),
}));

describe("Result laws", () => {
	describe("match / unwrap family", () => {
		test("match dispatches to exactly the matching handler", () => {
			fc.assert(
				fc.property(result_arb, (r) => {
					const out = match(
						r,
						(value): Tagged => ({ tag: "ok", value }),
						(error): Tagged => ({ tag: "err", error }),
					);
					expect(out.tag).toBe(r.ok ? "ok" : "err");
					expect(out.tag === "ok" ? out.value : out.error).toBe(payload(r));
				}),
			);
		});

		test("unwrap_or / to_nullable / to_fallback: value on ok, substitute on err", () => {
			fc.assert(
				fc.property(result_arb, fc.anything(), (r, substitute) => {
					expect(unwrap_or(r, substitute)).toBe(r.ok ? r.value : substitute);
					expect(to_fallback(r, substitute)).toBe(r.ok ? r.value : substitute);
					expect(to_nullable(r)).toBe(r.ok ? r.value : null);
				}),
			);
		});

		test("unwrap / unwrap_err return the payload of the matching variant", () => {
			fc.assert(
				fc.property(fc.anything(), (v) => {
					expect(unwrap(ok(v))).toBe(v);
					expect(unwrap_err(err(v))).toBe(v);
				}),
			);
		});

		test("null_on: predicate true -> null, false -> rethrows the same error, ok -> value", () => {
			fc.assert(
				fc.property(result_arb, fc.boolean(), (r, verdict) => {
					const { seen, pred } = recording_predicate(verdict);
					const c = caught(() => null_on(r, pred));
					if (r.ok) {
						expect(c.threw).toBe(false);
						expect(c.value).toBe(r.value);
						expect(seen).toHaveLength(0);
						return;
					}
					expect(seen).toHaveLength(1);
					expect(seen[0]).toBe(r.error);
					expect(c.threw).toBe(!verdict);
					expect(c.value).toBe(verdict ? null : r.error);
				}),
			);
		});

		test("fallback_on: predicate true -> fallback, false -> rethrows the same error, ok -> value", () => {
			fc.assert(
				fc.property(result_arb, fc.boolean(), fc.anything(), (r, verdict, fallback) => {
					const { seen, pred } = recording_predicate(verdict);
					const c = caught(() => fallback_on(r, pred, fallback));
					if (r.ok) {
						expect(c.threw).toBe(false);
						expect(c.value).toBe(r.value);
						expect(seen).toHaveLength(0);
						return;
					}
					expect(seen).toHaveLength(1);
					expect(seen[0]).toBe(r.error);
					expect(c.threw).toBe(!verdict);
					expect(c.value).toBe(verdict ? fallback : r.error);
				}),
			);
		});

		test("format_error: Error -> message, anything else -> String(x)", () => {
			fc.assert(
				fc.property(thrown_arb, (e) => {
					expect(format_error(e)).toBe(e instanceof Error ? e.message : stringify(e));
				}),
			);
		});
	});

	describe("try_catch / try_catch_async", () => {
		test("try_catch: returning fn -> ok(v) without calling the mapper; throwing fn -> err(mapper(thrown))", () => {
			fc.assert(
				fc.property(fc.anything(), fc.anything(), (v, t) => {
					const mapped: unknown[] = [];
					const on_error = (e: unknown): { wrapped: unknown } => {
						mapped.push(e);
						return { wrapped: e };
					};
					expect(expect_ok(try_catch(() => v, on_error))).toBe(v);
					expect(mapped).toHaveLength(0);

					const failure = expect_err(try_catch(() => raise(t), on_error));
					expect(failure.wrapped).toBe(t);
					expect(mapped).toHaveLength(1);
					expect(mapped[0]).toBe(t);
				}),
			);
		});

		test("try_catch_async: resolving fn -> ok(v); rejecting fn -> err(mapper(rejection))", async () => {
			await fc.assert(
				fc.asyncProperty(fc.anything(), fc.anything(), async (v, t) => {
					const mapped: unknown[] = [];
					const on_error = (e: unknown): { wrapped: unknown } => {
						mapped.push(e);
						return { wrapped: e };
					};
					expect(expect_ok(await try_catch_async(() => Promise.resolve(v), on_error))).toBe(v);
					expect(mapped).toHaveLength(0);

					const failure = expect_err(await try_catch_async(() => reject_with(t), on_error));
					expect(failure.wrapped).toBe(t);
					expect(mapped).toHaveLength(1);
					expect(mapped[0]).toBe(t);
				}),
			);
		});
	});

	describe("pipe vs standalone", () => {
		test("factories: pipe.ok / pipe.err / pipe.try / pipe(Promise<Result>) mirror the plain Results", async () => {
			await fc.assert(
				fc.asyncProperty(fc.anything(), result_arb, async (v, r) => {
					same(await pipe.ok(v).result(), ok(v));
					same(await pipe.err(v).result(), err(v));
					same(await pipe(Promise.resolve(r)).result(), r);
					same(
						await pipe
							.try(
								() => Promise.resolve(v),
								(e) => e,
							)
							.result(),
						ok(v),
					);
					same(
						await pipe
							.try(
								() => reject_with(v),
								(e) => ({ wrapped: e }),
							)
							.result(),
						err({ wrapped: v }),
					);
				}),
			);
		});

		test("map / map_async transform ok and pass err through untouched", async () => {
			await fc.assert(
				fc.asyncProperty(result_arb, async (r) => {
					const expected: R = r.ok ? ok([r.value]) : r;
					same(
						await pipe(r)
							.map((x) => [x])
							.result(),
						expected,
					);
					same(
						await pipe(r)
							.map_async(async (x) => {
								await Promise.resolve();
								return [x];
							})
							.result(),
						expected,
					);
				}),
			);
		});

		test("map_err transforms err and passes ok through untouched", async () => {
			await fc.assert(
				fc.asyncProperty(result_arb, async (r) => {
					const out = await pipe(r)
						.map_err((e) => ({ wrapped: e }))
						.result();
					same(out, r.ok ? r : err({ wrapped: r.error }));
				}),
			);
		});

		test("flat_map runs only on ok and short-circuits the rest of the chain after an err", async () => {
			await fc.assert(
				fc.asyncProperty(result_arb, fc.boolean(), async (r, g_ok) => {
					const calls_1: unknown[] = [];
					const calls_2: unknown[] = [];
					const g1 = (x: unknown): R => {
						calls_1.push(x);
						return g_ok ? ok([x]) : err("boom");
					};
					const g2 = (x: unknown): R => {
						calls_2.push(x);
						return ok(x);
					};
					const out = await pipe(r).flat_map(g1).flat_map(g2).result();

					expect(calls_1).toHaveLength(r.ok ? 1 : 0);
					expect(calls_2).toHaveLength(r.ok && g_ok ? 1 : 0);
					if (!r.ok) same(out, r);
					else same(out, g_ok ? ok([r.value]) : err("boom"));
				}),
			);
		});

		test("tap / tap_err fire their side effect once on the matching variant and never alter the result", async () => {
			await fc.assert(
				fc.asyncProperty(result_arb, async (r) => {
					const tapped: unknown[] = [];
					const tapped_err: unknown[] = [];
					const out = await pipe(r)
						.tap(async (x) => {
							await Promise.resolve();
							tapped.push(x);
						})
						.tap_err((e) => {
							tapped_err.push(e);
						})
						.result();
					same(out, r);
					expect(tapped).toHaveLength(r.ok ? 1 : 0);
					expect(tapped_err).toHaveLength(r.ok ? 0 : 1);
					if (r.ok) expect(tapped[0]).toBe(r.value);
					else expect(tapped_err[0]).toBe(r.error);
				}),
			);
		});

		test("pipe.unwrap_or equals standalone unwrap_or", async () => {
			await fc.assert(
				fc.asyncProperty(result_arb, fc.anything(), async (r, d) => {
					expect(await pipe(r).unwrap_or(d)).toBe(unwrap_or(r, d));
				}),
			);
		});
	});

	describe("merge_deep", () => {
		test("merging {} is the identity and returns a new object", () => {
			fc.assert(
				fc.property(tree_arb, (x) => {
					const merged = merge_deep(x, {});
					expect(merged).toEqual(x);
					expect(merged).not.toBe(x);
				}),
			);
		});

		test("scalar, null and array overrides replace wholesale; untouched keys and base survive", () => {
			fc.assert(
				fc.property(tree_arb, fc.dictionary(key_arb, leaf_arb), (base, overrides) => {
					const snapshot = structuredClone(base);
					const merged = merge_deep(base, overrides);
					Object.keys(overrides).forEach((k) => {
						expect(merged[k]).toEqual(overrides[k]);
					});
					Object.keys(base)
						.filter((k) => !(k in overrides))
						.forEach((k) => {
							expect(merged[k]).toEqual(base[k]);
						});
					expect(base).toEqual(snapshot);
				}),
			);
		});

		test("undefined overrides are ignored", () => {
			fc.assert(
				fc.property(fc.dictionary(key_arb, node_arb, { minKeys: 1 }), fc.nat(), (base, pick) => {
					const keys = Object.keys(base);
					const k = keys[pick % keys.length] ?? "a";
					expect(merge_deep(base, { [k]: undefined })).toEqual(base);
				}),
			);
		});

		test("nested objects merge recursively", () => {
			fc.assert(
				fc.property(
					fc.dictionary(key_arb, tree_arb, { minKeys: 1 }),
					fc.nat(),
					fc.dictionary(key_arb, leaf_arb),
					(base, pick, inner_overrides) => {
						const keys = Object.keys(base);
						const k = keys[pick % keys.length] ?? "a";
						const merged = merge_deep(base, { [k]: inner_overrides });
						expect(merged[k]).toEqual({ ...(base[k] as Record<string, unknown>), ...inner_overrides });
						Object.keys(base)
							.filter((other) => other !== k)
							.forEach((other) => {
								expect(merged[other]).toEqual(base[other]);
							});
					},
				),
			);
		});
	});

	describe("array accessors", () => {
		test("at is ok exactly for in-range, defined elements and otherwise reports {index, length}", () => {
			fc.assert(
				fc.property(
					fc.array(fc.option(fc.integer(), { nil: undefined }), { maxLength: 10 }),
					fc.integer({ min: -3, max: 13 }),
					(xs, i) => {
						const r = at(xs, i);
						const element = xs[i];
						if (i >= 0 && i < xs.length && element !== undefined) {
							expect(expect_ok(r)).toBe(element);
							return;
						}
						expect(expect_err(r)).toEqual({ kind: "index_out_of_bounds", index: i, length: xs.length });
					},
				),
				{ numRuns: 300 },
			);
		});

		test("first / last: empty -> empty_array, otherwise the ends", () => {
			fc.assert(
				fc.property(fc.array(fc.integer(), { maxLength: 10 }), (xs) => {
					if (xs.length === 0) {
						expect(expect_err(first(xs))).toEqual({ kind: "empty_array" });
						expect(expect_err(last(xs))).toEqual({ kind: "empty_array" });
						return;
					}
					expect(expect_ok(first(xs)) === xs.at(0)).toBe(true);
					expect(expect_ok(last(xs)) === xs.at(-1)).toBe(true);
				}),
			);
		});
	});
});
