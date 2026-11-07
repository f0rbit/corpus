/**
 * @module testing/arb-v4
 * @description Zod-v4 arm of the `testing.arb` walker. Zod 4 schemas expose
 * their definition on `schema._zod.def` with a `def.type` string
 * discriminant; v4 refinements are `custom` entries in `def.checks` (not a
 * ZodEffects wrapper) and `.brand()` is a type-level no-op, so a branded
 * schema is handled by its base walker.
 *
 * All access goes through structural types declared here — no import of a
 * zod generation in this file's emitted `.d.ts`. Def-shape facts were read
 * from zod 4.6.7's published `v4/core/schemas.d.ts` / `checks.d.ts`:
 * - string constraints are checks with `check: "min_length" | "max_length" |
 *   "length_equals"`; bare string-format schema classes (`z.uuid()`,
 *   `z.email()`, `z.string().datetime()`) carry the format on the def itself
 *   as `def.check === "string_format"` with `def.format` (and `def.pattern`
 *   for regex-like formats).
 * - `z.number().int()` attaches a `check: "number_format"` check with
 *   `format: "safeint" | "int32" | "uint32"` (verified in `v4/core/api.js`).
 * - object `def.shape` is a plain shape object (may surface as a thunk in
 *   hosted-construction edges), record def has `keyType`/`valueType`,
 *   tuple def `items`, union def `options` (discriminated unions are
 *   `type: "union"` plus a `discriminator` — walked identically), lazy def
 *   `getter`, enum def `entries`, literal def `values`.
 *
 * Unsupported kinds throw the same actionable message as the v3 walker,
 * pointing at `testing.arbitrary(schema, gen)`; a `custom` check (refinement)
 * throws naming `refinement`, the v4 counterpart of v3's ZodEffects.
 */

import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import type { SchemaLike } from "../types.js";
import { lookup_sync } from "./registry.js";
import type { WalkContext } from "./arb-common.js";
import { email_arb, datetime_arb, spread_merge } from "./arb-common.js";

type V4Check = {
	readonly check: string;
	readonly format?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly length?: number;
	readonly value?: unknown;
	readonly pattern?: RegExp;
};

// `def.checks` entries are check INSTANCES: the check's own def (the shape
// above) lives at `instance._zod.def`, not on the instance itself.
type V4CheckInstance = { readonly _zod?: { readonly def?: V4Check } };

function checks_of(def: { readonly checks?: readonly V4CheckInstance[] | undefined }): V4Check[] {
	return (def.checks ?? []).flatMap((c) => (c._zod?.def ? [c._zod.def] : []));
}

type V4Def = {
	readonly type: string;
	readonly check?: string;
	readonly format?: string;
	readonly pattern?: RegExp;
	readonly checks?: readonly V4CheckInstance[] | undefined;
	readonly values?: readonly unknown[];
	readonly entries?: Record<string, string | number>;
	readonly shape?: unknown;
	readonly element?: unknown;
	readonly items?: readonly unknown[];
	readonly options?: readonly unknown[];
	readonly innerType?: unknown;
	readonly keyType?: unknown;
	readonly valueType?: unknown;
	readonly left?: unknown;
	readonly right?: unknown;
	readonly getter?: () => unknown;
};

export type V4Schema = SchemaLike & { readonly _zod: { readonly def: V4Def } };

const INT_NUMBER_FORMATS = new Set(["int32", "uint32", "safeint"]);

export function walk_v4(schema: V4Schema, ctx: WalkContext): Arbitrary<unknown> {
	const registered = lookup_sync(schema);
	if (registered) return registered;

	const def = schema._zod.def;
	// Refinement-class `custom` checks (from .refine()) change how values are
	// matched — v3's equivalent (ZodEffects wrapper) threw, so mirror that with
	// the generation-specific name `refinement`. NOTE: `overwrite` checks
	// (.overwrite, .trim, .toLowerCase, …) are deliberately NOT thrown —
	// v3's walker silently ignores its `trim` check and this mirrors that;
	// generated values are valid input to the schema.
	const refinement = checks_of(def).find((c) => c.check === "custom");
	if (refinement) throw new Error(unsupported_message("refinement"));
	return walk_def(def, ctx);
}

function walk_def(def: V4Def, ctx: WalkContext): Arbitrary<unknown> {
	switch (def.type) {
		case "string":
			return string_arb(def);
		case "number":
		case "int":
			return number_arb(def);
		case "boolean":
			return fc.boolean();
		case "bigint":
			return fc.bigInt();
		case "date":
			return fc.date();
		case "any":
		case "unknown":
			return fc.anything();
		case "literal":
			return literal_arb(def);
		case "enum":
			return enum_arb(def);
		case "object":
			return object_arb(def, ctx);
		case "array":
			return array_arb(def, ctx);
		case "tuple":
			return tuple_arb(def, ctx);
		case "union":
			return union_arb(def, ctx);
		case "record":
			return record_arb(def, ctx);
		case "intersection":
			return fc.tuple(walk_child(def.left, ctx), walk_child(def.right, ctx)).map(spread_merge);
		case "optional":
			return fc.option(walk_child(def.innerType, ctx), { nil: undefined });
		case "nullable":
			return fc.option(walk_child(def.innerType, ctx), { nil: null });
		case "default":
			return walk_child(def.innerType, ctx);
		case "lazy":
			return lazy_arb(def.getter, ctx);
		default:
			throw new Error(unsupported_message(def.type));
	}
}

function walk_child(child: unknown, ctx: WalkContext): Arbitrary<unknown> {
	// Generation dispatch boundary: the child is a real v4 schema instance
	// (typed `SomeType` by zod, opaque here), so the cast only widens the
	// structural v4 shape back onto the value.
	return walk_v4(child as V4Schema, ctx);
}

function string_arb(def: V4Def): Arbitrary<string> {
	// v4's string-format schema classes (z.uuid(), z.email(), z.string().datetime(), …)
	// carry their format check on the def itself; plain z.string() schemas keep
	// constraints only inside def.checks. Same first-match-found semantics as
	// the v3 walker: a format wins over min/max, unknown formats degrade to a
	// plain string exactly like v3 ignores unknown checks.
	const mine: V4Check[] = def.check === "string_format" ? [def as V4Check] : [];
	for (const c of [...mine, ...checks_of(def)]) {
		if (c.check === "string_format") {
			if (c.format === "uuid") return fc.uuid();
			if (c.format === "email") return email_arb();
			if (c.format === "datetime") return datetime_arb();
			if (c.format === "regex" && c.pattern) return fc.stringMatching(c.pattern);
		}
	}

	const checks = checks_of(def);
	const min = checks.find((c) => c.check === "min_length");
	const max = checks.find((c) => c.check === "max_length");
	const length = checks.find((c) => c.check === "length_equals");
	if (length) {
		return length.length === undefined
			? fc.string()
			: fc.string({ minLength: length.length, maxLength: length.length });
	}
	const opts: { minLength?: number; maxLength?: number } = {};
	if (min?.minimum !== undefined) opts.minLength = min.minimum;
	if (max?.maximum !== undefined) opts.maxLength = max.maximum;
	return fc.string(opts);
}

function number_arb(def: V4Def): Arbitrary<number> {
	const checks = checks_of(def);
	const is_int =
		def.type === "int" ||
		checks.some((c) => c.check === "number_format" && c.format !== undefined && INT_NUMBER_FORMATS.has(c.format));
	const min_check = checks.find((c) => c.check === "greater_than");
	const max_check = checks.find((c) => c.check === "less_than");
	// greater_than/less_than defs carry their bound on `value` (number | bigint |
	// Date per util.Numeric); numeric schemas only hit the number branch here.
	const min = typeof min_check?.value === "number" ? min_check.value : undefined;
	const max = typeof max_check?.value === "number" ? max_check.value : undefined;
	if (is_int) {
		const opts: { min?: number; max?: number } = {};
		if (min !== undefined) opts.min = Math.ceil(min);
		if (max !== undefined) opts.max = Math.floor(max);
		return fc.integer(opts);
	}
	const opts: { min?: number; max?: number; noNaN?: boolean; noDefaultInfinity?: boolean } = {
		// zod 4 rejects NaN AND +/-Infinity for z.number() (v3 accepted Infinity)
		noNaN: true,
		noDefaultInfinity: true,
	};
	if (min !== undefined) opts.min = min;
	if (max !== undefined) opts.max = max;
	return fc.double(opts);
}

function literal_arb(def: V4Def): Arbitrary<unknown> {
	const values = def.values ?? [];
	if (values.length === 1) return fc.constant(values[0]);
	return fc.constantFrom(...(values as (string | number | bigint | boolean | null)[]));
}

function enum_arb(def: V4Def): Arbitrary<unknown> {
	const values = Object.values(def.entries ?? {});
	return fc.constantFrom(...values);
}

function object_arb(def: V4Def, ctx: WalkContext): Arbitrary<Record<string, unknown>> {
	// Object shape facts: the def normally carries a plain shape object, but a
	// def may surface a shape accessor at construction edges — normalise both.
	const raw = def.shape;
	const shape = (typeof raw === "function" ? (raw as () => Record<string, unknown>)() : raw) as
		| Record<string, unknown>
		| undefined;
	const entries: Record<string, Arbitrary<unknown>> = {};
	for (const key of Object.keys(shape ?? {})) {
		const child = shape?.[key];
		if (!child || typeof child !== "object") continue;
		entries[key] = walk_child(child, ctx);
	}
	return fc.record(entries);
}

function array_arb(def: V4Def, ctx: WalkContext): Arbitrary<unknown[]> {
	const checks = checks_of(def);
	const opts: { minLength?: number; maxLength?: number } = {};
	const min = checks.find((c) => c.check === "min_length");
	const max = checks.find((c) => c.check === "max_length");
	const exact = checks.find((c) => c.check === "length_equals");
	if (exact?.length !== undefined) {
		opts.minLength = exact.length;
		opts.maxLength = exact.length;
	} else {
		if (min?.minimum !== undefined) opts.minLength = min.minimum;
		if (max?.maximum !== undefined) opts.maxLength = max.maximum;
	}
	return fc.array(walk_child(def.element, ctx), opts);
}

function tuple_arb(def: V4Def, ctx: WalkContext): Arbitrary<unknown[]> {
	const arbs = (def.items ?? []).map((item) => walk_child(item, ctx));
	return fc.tuple(...arbs);
}

function union_arb(def: V4Def, ctx: WalkContext): Arbitrary<unknown> {
	const arbs = (def.options ?? []).map((o) => walk_child(o, ctx));
	return fc.oneof(...arbs);
}

function record_arb(def: V4Def, ctx: WalkContext): Arbitrary<Record<string, unknown>> {
	const key_arb = walk_child(def.keyType, ctx);
	const value_arb = walk_child(def.valueType, ctx);
	return fc.dictionary(key_arb as Arbitrary<string>, value_arb);
}

function lazy_arb(getter: (() => unknown) | undefined, ctx: WalkContext): Arbitrary<unknown> {
	if (!getter) throw new Error(unsupported_message("lazy"));
	const existing = ctx.lazy_ties.get(getter);
	if (existing) return existing;
	// fast-check's depth bookkeeping is driven by fc.oneof, not by fc.letrec
	// alone (same recipe as the v3 walker); the def's getter is the per-schema
	// identity key for recursion sites.
	const { self } = fc.letrec<{ self: unknown }>((tie) => {
		ctx.lazy_ties.set(getter, tie("self"));
		const body = walk_child(getter(), ctx);
		return {
			self: fc.oneof({ depthSize: "small", maxDepth: 3 }, body, tie("self")),
		};
	});
	ctx.lazy_ties.set(getter, self);
	return self;
}

function unsupported_message(kind: string): string {
	return (
		`testing.arb: unsupported schema kind '${kind}'. ` +
		`Register a generator manually via testing.arbitrary(schema, gen) ` +
		`at the test setup, or open a follow-up to extend the walker.`
	);
}
