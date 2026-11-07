/**
 * @module testing/arb
 * @description Translates a Zod schema into an `fc.Arbitrary` that produces
 * values matching the schema, for BOTH supported zod generations. First
 * consults the registry (schema-identity lookup) so consumers can register a
 * canonical generator for any schema; if the schema isn't registered,
 * dispatches on generation — v4 schemas carry an `_zod` property, v3 schemas
 * don't — to a hand-rolled walker per generation:
 *
 * - `arb-v3.ts`: `instanceof` over the classes imported from `zod/v3`.
 * - `arb-v4.ts`: structural walk over `schema._zod.def` (no zod generation
 *   imported, so its emitted types stay generation-neutral).
 *
 * Both arms cover the same surface (primitives with constraints, objects,
 * arrays, tuples, unions, optional/nullable/default, records, intersections,
 * lazy cycles) for zod versions whose manifest satisfies the peer range
 * (`>=3.25.0`), and raise the same actionable error for unsupported kinds
 * (v3: e.g. `ZodEffects`; v4: refinements surface as `custom` checks),
 * pointing the user at the manual-registration escape hatch via
 * `testing.arbitrary(schema, gen)`.
 *
 * The public signature accepts `SchemaLike` (from `./types.js`) — never a
 * zod-typed class — so the only zod-generational cast is the dispatch
 * boundary plus the single `as Arbitrary<SchemaInferred<S>>` at the registry
 * boundary below.
 */

import type { Arbitrary } from "fast-check";
import type { z as z3 } from "zod/v3";
import type { SchemaLike } from "../types.js";
import type { SchemaInferred } from "./types.js";
import type { WalkContext } from "./arb-common.js";
import { walk_v3 } from "./arb-v3.js";
import { walk_v4, type V4Schema } from "./arb-v4.js";
// lookup_sync, deliberately: arb() is a synchronous API, so it consults only
// registrations already made in this process and never triggers the vending
// auto-loader. Await testing.lookup(...) (or testing.load_from(...)) first if
// vended registrations should be visible to the walker.
import { lookup_sync } from "./registry.js";

/**
 * Translate a Zod schema into an `fc.Arbitrary` producing values matching the
 * schema. Accepts zod 3 AND zod 4 schemas.
 *
 * Consults the registry first; falls through to a hand-rolled walker that
 * handles primitives, objects, arrays, tuples, unions, optional/nullable,
 * branded, default, records, intersections, and lazy cycles.
 *
 * @example
 * ```ts
 * import { z } from 'zod' // works under zod 3 and zod 4
 *
 * const UserSchema = z.object({ id: z.string().uuid(), name: z.string() })
 * fc.assert(fc.property(arb(UserSchema), (u) => UserSchema.safeParse(u).success))
 * ```
 */
export function arb<S extends SchemaLike>(schema: S): Arbitrary<SchemaInferred<S>> {
	const registered = lookup_sync(schema);
	if (registered) return registered;
	const ctx: WalkContext = { lazy_ties: new WeakMap() };
	if (is_v4_schema(schema)) {
		// Generation dispatch boundary: the `_zod` presence flag is the runtime
		// contract; the casts only re-attach the generation's own shape.
		const derived = walk_v4(schema as V4Schema, ctx);
		// Registry-boundary escape hatch: the internal walker returns
		// Arbitrary<unknown>; the public generic resolves the schema's output type.
		return derived as Arbitrary<SchemaInferred<S>>;
	}
	const derived = walk_v3(schema as unknown as V3ZodType, ctx);
	return derived as Arbitrary<SchemaInferred<S>>;
}

type V3ZodType = z3.ZodType;

export function is_v4_schema(schema: SchemaLike): schema is SchemaLike & { _zod: unknown } {
	return "_zod" in schema;
}
