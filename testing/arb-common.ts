/**
 * @module testing/arb-common
 * @description Helpers shared by the zod-v3 and zod-v4 walkers in
 * `arb-v3.ts` / `arb-v4.ts`: the walk context, the generation-specific
 * arbitrary factories with generation-specific quirks (email format
 * strictness, ISO-datetime year window), and the intersection merge.
 */

import fc from "fast-check";
import type { Arbitrary } from "fast-check";

export type WalkContext = {
	/** Per-schema-instance tie memo for lazy (recursive) schemas. */
	lazy_ties: WeakMap<object, Arbitrary<unknown>>;
};

export function email_arb(): Arbitrary<string> {
	// fc.emailAddress() honours RFC 5322, which permits characters (e.g. '!', '#')
	// and consecutive dots that Zod's .email() regex rejects — in BOTH generations.
	// Build a conservative form: simple alphanumeric local-part @ domain . tld.
	const local = fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/);
	const domain = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
	const tld = fc.stringMatching(/^[a-z]{2,6}$/);
	return fc.tuple(local, domain, tld).map(([l, d, t]) => `${l}@${d}.${t}`);
}

export function datetime_arb(): Arbitrary<string> {
	// Zod's .datetime() rejects BC-era / 6-digit-year ISO strings in both
	// generations; clamp to the safe window 1970-01-01 .. 2999-12-31 so
	// generated strings always parse.
	const min = Date.UTC(1970, 0, 1);
	const max = Date.UTC(2999, 11, 31, 23, 59, 59, 999);
	return fc.integer({ min, max }).map((ms) => new Date(ms).toISOString());
}

export function spread_merge([l, r]: readonly [unknown, unknown]): unknown {
	return Object.assign({}, l, r);
}
