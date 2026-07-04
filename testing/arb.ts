/**
 * @module testing/arb
 * @description Translates a Zod schema into an `fc.Arbitrary` that produces
 * values matching the schema. First consults the registry (schema-identity
 * lookup) so consumers can register a canonical generator for any schema; if
 * the schema isn't registered, dispatches on Zod class identity to a
 * hand-rolled walker covering the ~14 cases that drive 99% of corpus's
 * domain schemas.
 *
 * Unsupported kinds (e.g. `ZodEffects`, `ZodCatch`, `ZodPipe`) raise a clear
 * error pointing the user at the manual-registration escape hatch via
 * `testing.arbitrary(schema, gen)`.
 *
 * The fallback to `@traversable/zod-test`'s `generator(schema)` documented in
 * the original plan is deferred — that package declares `zod: 4` as a peer
 * while corpus uses `zod@3`, and its `@traversable/zod-types` peer is
 * missing in the install graph. Phase 1 ships hand-roll-only; the fallback
 * decision is revisited if/when we move to zod 4.
 *
 * Dispatch uses `instanceof` (not `_def.typeName`) so TypeScript narrows the
 * schema type at each branch. The single `as fc.Arbitrary<z.infer<S>>` at
 * the registry boundary is the only escape-hatch cast in the file.
 */

import { z } from "zod";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
// lookup_sync, deliberately: arb() is a synchronous API, so it consults only
// registrations already made in this process and never triggers the vending
// auto-loader. Await testing.lookup(...) (or testing.load_from(...)) first if
// vended registrations should be visible to the walker.
import { lookup_sync } from "./registry.js";

/**
 * Translate a Zod schema into an `fc.Arbitrary` producing values matching the
 * schema.
 *
 * Consults the registry first; falls through to a hand-rolled walker that
 * handles primitives, objects, arrays, tuples, unions, optional/nullable,
 * branded, default, records, intersections, and lazy cycles.
 *
 * @example
 * ```ts
 * const UserSchema = z.object({ id: z.string().uuid(), name: z.string() })
 * fc.assert(fc.property(arb(UserSchema), (u) => UserSchema.safeParse(u).success))
 * ```
 */
export function arb<S extends z.ZodType>(schema: S): Arbitrary<z.infer<S>> {
	const registered = lookup_sync(schema);
	if (registered) return registered;
	const ctx: WalkContext = { lazy_ties: new WeakMap() };
	return walk(schema, ctx);
}

type WalkContext = {
	lazy_ties: WeakMap<z.ZodLazy<z.ZodType>, Arbitrary<unknown>>;
};

function walk(schema: z.ZodType, ctx: WalkContext): Arbitrary<unknown> {
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
	if (schema instanceof z.ZodOptional) return fc.option(walk(schema._def.innerType, ctx), { nil: undefined });
	if (schema instanceof z.ZodNullable) return fc.option(walk(schema._def.innerType, ctx), { nil: null });
	if (schema instanceof z.ZodBranded) return walk(schema._def.type, ctx);
	if (schema instanceof z.ZodDefault) return walk(schema._def.innerType, ctx);
	if (schema instanceof z.ZodRecord) return record_arb(schema, ctx);
	if (schema instanceof z.ZodIntersection) return intersection_arb(schema, ctx);
	if (schema instanceof z.ZodLazy) return lazy_arb(schema, ctx);
	if (schema instanceof z.ZodAny) return fc.anything();
	if (schema instanceof z.ZodUnknown) return fc.anything();
	throw new Error(unsupported_message(schema));
}

function email_arb(): Arbitrary<string> {
	// fast-check's fc.emailAddress() honours RFC 5322, which permits characters
	// (e.g. '!', '#') and consecutive dots that Zod's .email() regex rejects.
	// Build a conservative form: simple alphanumeric local-part @ domain . tld.
	const local = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
	const domain = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
	const tld = fc.stringMatching(/^[a-z]{2,6}$/);
	return fc.tuple(local, domain, tld).map(([l, d, t]) => `${l}@${d}.${t}`);
}

function datetime_arb(): Arbitrary<string> {
	// Zod's .datetime() rejects BC-era / 6-digit-year ISO strings; clamp to the
	// safe window 1970-01-01 .. 2999-12-31 so generated strings always parse.
	const min = Date.UTC(1970, 0, 1);
	const max = Date.UTC(2999, 11, 31, 23, 59, 59, 999);
	return fc.integer({ min, max }).map((ms) => new Date(ms).toISOString());
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
	if (length && length.kind === "length") {
		return fc.string({ minLength: length.value, maxLength: length.value });
	}
	const opts: { minLength?: number; maxLength?: number } = {};
	if (min && min.kind === "min") opts.minLength = min.value;
	if (max && max.kind === "max") opts.maxLength = max.value;
	return fc.string(opts);
}

function number_arb(schema: z.ZodNumber): Arbitrary<number> {
	const checks = schema._def.checks;
	const is_int = checks.some((c) => c.kind === "int");
	const min_check = checks.find((c) => c.kind === "min");
	const max_check = checks.find((c) => c.kind === "max");
	const min = min_check && min_check.kind === "min" ? min_check.value : undefined;
	const max = max_check && max_check.kind === "max" ? max_check.value : undefined;
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
		entries[key] = walk(child, ctx);
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
	return fc.array(walk(def.type, ctx), opts);
}

function tuple_arb(schema: z.ZodTuple, ctx: WalkContext): Arbitrary<unknown[]> {
	const items = schema._def.items;
	const arbs = items.map((item) => walk(item, ctx));
	return fc.tuple(...arbs);
}

function union_arb(options: readonly z.ZodType[], ctx: WalkContext): Arbitrary<unknown> {
	const arbs = options.map((o) => walk(o, ctx));
	return fc.oneof(...arbs);
}

function record_arb(schema: z.ZodRecord<z.ZodString, z.ZodType>, ctx: WalkContext): Arbitrary<Record<string, unknown>> {
	const key_arb = walk(schema._def.keyType, ctx);
	const value_arb = walk(schema._def.valueType, ctx);
	return fc.dictionary(key_arb as Arbitrary<string>, value_arb);
}

function intersection_arb(schema: z.ZodIntersection<z.ZodType, z.ZodType>, ctx: WalkContext): Arbitrary<unknown> {
	return fc.tuple(walk(schema._def.left, ctx), walk(schema._def.right, ctx)).map(spread_merge);
}

function spread_merge([l, r]: readonly [unknown, unknown]): unknown {
	return Object.assign({}, l, r);
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
		const body = walk(schema._def.getter(), ctx);
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
