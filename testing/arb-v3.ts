/**
 * @module testing/arb-v3
 * @description Zod-v3 arm of the `testing.arb` walker. Dispatches on class
 * identity via `instanceof` against the classes imported from `zod/v3` — the
 * export subpath is present on EVERY zod version whose package manifest
 * satisfies the peer range (`>=3.25.0`) and always re-exports the same v3
 * classes the schemas under a v3-flavoured root install carry, so the
 * `instanceof` checks hold regardless of which generation is installed at
 * the repo root.
 *
 * The v3-specific `as` casts (dispatch entry and fc.dictionary's key parameter)
 * are sanctioned by the `testing/arb.*` eslint override; the generation dispatch
 * and the registry-boundary cast live in the caller, `testing/arb.ts`.
 */

import { z } from "zod/v3";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { lookup_sync } from "./registry.js";
import type { WalkContext } from "./arb-common.js";
import { email_arb, datetime_arb, spread_merge } from "./arb-common.js";

export function walk_v3(schema: z.ZodType, ctx: WalkContext): Arbitrary<unknown> {
	const registered = lookup_sync(schema);
	if (registered) return registered;
	if (schema instanceof z.ZodString) return string_arb(schema);
	if (schema instanceof z.ZodNumber) return number_arb(schema);
	if (schema instanceof z.ZodBigInt) return fc.bigInt();
	if (schema instanceof z.ZodBoolean) return fc.boolean();
	if (schema instanceof z.ZodDate) return fc.date();
	if (schema instanceof z.ZodLiteral) return fc.constant(schema._def.value);
	if (schema instanceof z.ZodEnum) return fc.constantFrom(...schema._def.values);
	if (schema instanceof z.ZodNativeEnum) return fc.constantFrom(...Object.values(schema._def.values));
	if (schema instanceof z.ZodObject) return object_arb(schema, ctx);
	if (schema instanceof z.ZodArray) return array_arb(schema, ctx);
	if (schema instanceof z.ZodTuple) return tuple_arb(schema, ctx);
	if (schema instanceof z.ZodDiscriminatedUnion) return union_arb(schema._def.options, ctx);
	if (schema instanceof z.ZodUnion) return union_arb(schema._def.options, ctx);
	if (schema instanceof z.ZodOptional) return fc.option(walk_v3(schema._def.innerType, ctx), { nil: undefined });
	if (schema instanceof z.ZodNullable) return fc.option(walk_v3(schema._def.innerType, ctx), { nil: null });
	if (schema instanceof z.ZodBranded) return walk_v3(schema._def.type, ctx);
	if (schema instanceof z.ZodDefault) return walk_v3(schema._def.innerType, ctx);
	if (schema instanceof z.ZodRecord) return record_arb(schema, ctx);
	if (schema instanceof z.ZodIntersection) return intersection_arb(schema, ctx);
	if (schema instanceof z.ZodLazy) return lazy_arb(schema, ctx);
	if (schema instanceof z.ZodAny) return fc.anything();
	if (schema instanceof z.ZodUnknown) return fc.anything();
	throw new Error(unsupported_message(schema));
}

function string_arb(schema: z.ZodString): Arbitrary<string> {
	const checks = schema._def.checks;
	for (const c of checks) {
		if (c.kind === "uuid") return fc.uuid();
		if (c.kind === "email") return email_arb();
		if (c.kind === "regex") return fc.stringMatching(c.regex);
		if (c.kind === "datetime") return datetime_arb();
	}
	const min = checks.find((c) => c.kind === "min");
	const max = checks.find((c) => c.kind === "max");
	const length = checks.find((c) => c.kind === "length");
	if (length) {
		return fc.string({ minLength: length.value, maxLength: length.value });
	}
	const opts: { minLength?: number; maxLength?: number } = {};
	if (min) opts.minLength = min.value;
	if (max) opts.maxLength = max.value;
	return fc.string(opts);
}

function number_arb(schema: z.ZodNumber): Arbitrary<number> {
	const checks = schema._def.checks;
	const is_int = checks.some((c) => c.kind === "int");
	const min_check = checks.find((c) => c.kind === "min");
	const max_check = checks.find((c) => c.kind === "max");
	const min = min_check?.value;
	const max = max_check?.value;
	if (is_int) {
		const opts: { min?: number; max?: number } = {};
		if (min !== undefined) opts.min = Math.ceil(min);
		if (max !== undefined) opts.max = Math.floor(max);
		return fc.integer(opts);
	}
	const opts: { min?: number; max?: number; noNaN?: boolean } = { noNaN: true };
	if (min !== undefined) opts.min = min;
	if (max !== undefined) opts.max = max;
	return fc.double(opts);
}

function object_arb(schema: z.ZodObject<z.ZodRawShape>, ctx: WalkContext): Arbitrary<Record<string, unknown>> {
	const shape = schema._def.shape();
	const entries: Record<string, Arbitrary<unknown>> = {};
	for (const key of Object.keys(shape)) {
		const child = shape[key];
		if (!child) continue;
		entries[key] = walk_v3(child, ctx);
	}
	return fc.record(entries);
}

function array_arb(schema: z.ZodArray<z.ZodType>, ctx: WalkContext): Arbitrary<unknown[]> {
	const def = schema._def;
	const opts: { minLength?: number; maxLength?: number } = {};
	if (def.minLength) opts.minLength = def.minLength.value;
	if (def.maxLength) opts.maxLength = def.maxLength.value;
	if (def.exactLength) {
		opts.minLength = def.exactLength.value;
		opts.maxLength = def.exactLength.value;
	}
	return fc.array(walk_v3(def.type, ctx), opts);
}

function tuple_arb(schema: z.ZodTuple, ctx: WalkContext): Arbitrary<unknown[]> {
	const items = schema._def.items;
	const arbs = items.map((item) => walk_v3(item, ctx));
	return fc.tuple(...arbs);
}

function union_arb(options: readonly z.ZodType[], ctx: WalkContext): Arbitrary<unknown> {
	const arbs = options.map((o) => walk_v3(o, ctx));
	return fc.oneof(...arbs);
}

function record_arb(schema: z.ZodRecord<z.ZodString, z.ZodType>, ctx: WalkContext): Arbitrary<Record<string, unknown>> {
	const key_arb = walk_v3(schema._def.keyType, ctx);
	const value_arb = walk_v3(schema._def.valueType, ctx);
	return fc.dictionary(key_arb as Arbitrary<string>, value_arb);
}

function intersection_arb(schema: z.ZodIntersection<z.ZodType, z.ZodType>, ctx: WalkContext): Arbitrary<unknown> {
	return fc.tuple(walk_v3(schema._def.left, ctx), walk_v3(schema._def.right, ctx)).map(spread_merge);
}

function lazy_arb(schema: z.ZodLazy<z.ZodType>, ctx: WalkContext): Arbitrary<unknown> {
	const existing = ctx.lazy_ties.get(schema);
	if (existing) return existing;
	// fast-check's depth bookkeeping is driven by fc.oneof, not by fc.letrec
	// alone. Walking the lazy's body produces an arbitrary that contains
	// `tie("self")` at recursion sites (typically inside fc.array). We wrap
	// the body in fc.oneof with `depthSize: "small"` + maxDepth so fast-check
	// caps recursion depth at a finite level — both for generation and for
	// shrinking, which would otherwise overflow the stack on deep self-refs.
	const { self } = fc.letrec<{ self: unknown }>((tie) => {
		ctx.lazy_ties.set(schema, tie("self"));
		const body = walk_v3(schema._def.getter(), ctx);
		return {
			self: fc.oneof({ depthSize: "small", maxDepth: 3 }, body, tie("self")),
		};
	});
	ctx.lazy_ties.set(schema, self);
	return self;
}

function unsupported_message(schema: z.ZodType): string {
	const type_name = (schema as { _def?: { typeName?: string } })._def?.typeName ?? schema.constructor.name;
	return (
		`testing.arb: unsupported schema kind '${type_name}'. ` +
		`Register a generator manually via testing.arbitrary(schema, gen) ` +
		`at the test setup, or open a follow-up to extend the walker.`
	);
}
