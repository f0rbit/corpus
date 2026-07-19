/**
 * Property test for `copy()` (copy.ts, plan task 3.1): memory → memory,
 * generated snapshot sets.
 *
 * Asserts the two invariants the plan calls out specifically:
 * - idempotency — running `copy()` a second time against the same
 *   (source, dest) pair reports zero copies (everything skip-hit)
 * - fidelity — the destination's listing, per store, canonical-sorted and
 *   normalised per the equivalence-rule convention (Dates compared at epoch
 *   ms, list order-independent), equals the source's listing
 *
 * Both backends are `create_memory_backend()`, so the file-backend
 * `data_path` `/`→`_` aliasing gotcha (documented in
 * tests/integration/copy.test.ts's header) doesn't apply here — data keys
 * are still kept in the default `${store_id}/${content_hash}` shape anyway,
 * for realism.
 *
 * Uses a richer LOCAL meta arbitrary (parents + invoked_at), not the
 * registered `SNAPSHOT_META_BRAND` arbitrary — per AGENTS.md, that brand
 * always emits `parents: []` and never `invoked_at`. Payload arbitraries are
 * plain `fc.*` (record/array/constantFrom/option/date/uniqueArray), so
 * fast-check's default shrinker applies cleanly — no `testing.compose`
 * involved, so none of the `fc.gen()` non-terminating-shrink hazard.
 */

import { describe, test } from "bun:test";
import fc from "fast-check";
import { copy } from "../../copy.js";
import { create_memory_backend } from "../../backend/memory.js";
import type { Backend, SnapshotMeta } from "../../types.js";

const STORE_IDS = ["alpha", "beta"] as const;
const VERSIONS = ["v1", "v2", "v3", "v4", "v5"] as const;

const CONTENTS = [
	{ hash: "hash-alpha", bytes: new TextEncoder().encode("content-alpha") },
	{ hash: "hash-beta", bytes: new TextEncoder().encode("content-beta") },
	{ hash: "hash-gamma", bytes: new TextEncoder().encode("content-gamma") },
] as const;

const date_arb = fc.date({
	min: new Date("2000-01-01T00:00:00.000Z"),
	max: new Date("2100-01-01T00:00:00.000Z"),
	noInvalidDate: true,
});

type Spec = {
	store_id: (typeof STORE_IDS)[number];
	version: (typeof VERSIONS)[number];
	content_idx: 0 | 1 | 2;
	parents: Array<{ store_id: (typeof STORE_IDS)[number]; version: (typeof VERSIONS)[number] }>;
	created_at: Date;
	invoked_at: Date | undefined;
	tags: string[] | undefined;
};

const spec_arb: fc.Arbitrary<Spec> = fc.record({
	store_id: fc.constantFrom(...STORE_IDS),
	version: fc.constantFrom(...VERSIONS),
	content_idx: fc.constantFrom(0, 1, 2),
	parents: fc.array(fc.record({ store_id: fc.constantFrom(...STORE_IDS), version: fc.constantFrom(...VERSIONS) }), {
		maxLength: 2,
	}),
	created_at: date_arb,
	invoked_at: fc.option(date_arb, { nil: undefined }),
	tags: fc.option(fc.array(fc.constantFrom("draft", "reviewed", "hot"), { maxLength: 3 }), { nil: undefined }),
});

const specs_arb = fc.uniqueArray(spec_arb, {
	selector: (s) => `${s.store_id}:${s.version}`,
	minLength: 1,
	maxLength: 12,
});

type NormMeta = {
	store_id: string;
	version: string;
	parents: ReadonlyArray<{ store_id: string; version: string }>;
	created_at: number;
	invoked_at?: number;
	content_hash: string;
	content_type: string;
	size_bytes: number;
	data_key: string;
	tags?: readonly string[];
};

const norm_meta = (m: SnapshotMeta): NormMeta => ({
	store_id: m.store_id,
	version: m.version,
	parents: m.parents.map((p) => ({ store_id: p.store_id, version: p.version })),
	created_at: m.created_at.getTime(),
	...(m.invoked_at === undefined ? {} : { invoked_at: m.invoked_at.getTime() }),
	content_hash: m.content_hash,
	content_type: m.content_type,
	size_bytes: m.size_bytes,
	data_key: m.data_key,
	...(m.tags === undefined ? {} : { tags: [...m.tags] }),
});

const canonical = (metas: SnapshotMeta[]): NormMeta[] =>
	metas.map(norm_meta).toSorted((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));

async function seed(backend: Backend, specs: readonly Spec[]): Promise<void> {
	for (const spec of specs) {
		const content = CONTENTS[spec.content_idx];
		const data_key = `${spec.store_id}/${content.hash}`;
		const meta: SnapshotMeta = {
			store_id: spec.store_id,
			version: spec.version,
			parents: spec.parents,
			created_at: spec.created_at,
			invoked_at: spec.invoked_at,
			content_hash: content.hash,
			content_type: "application/octet-stream",
			size_bytes: content.bytes.byteLength,
			data_key,
			tags: spec.tags,
		};
		const data_put = await backend.data.put(data_key, content.bytes);
		if (!data_put.ok) throw new Error(`seed: data.put failed (${data_put.error.kind})`);
		const meta_put = await backend.metadata.put(meta);
		if (!meta_put.ok) throw new Error(`seed: metadata.put failed (${meta_put.error.kind})`);
	}
}

async function collect(backend: Backend, store_id: string): Promise<SnapshotMeta[]> {
	const out: SnapshotMeta[] = [];
	for await (const meta of backend.metadata.list(store_id)) out.push(meta);
	return out;
}

describe("property: copy() — memory to memory", () => {
	test("second run copies nothing (idempotency) and dest listing matches source (fidelity)", async () => {
		await fc.assert(
			fc.asyncProperty(specs_arb, async (specs) => {
				const source = create_memory_backend();
				await seed(source, specs);
				const dest = create_memory_backend();

				const first = await copy(source, dest);
				if (!first.ok) throw new Error(`copy() failed: ${first.error.kind}`);

				const second = await copy(source, dest);
				if (!second.ok) throw new Error(`second copy() failed: ${second.error.kind}`);
				if (second.value.versions_copied !== 0 || second.value.data_objects_copied !== 0) {
					throw new Error(
						`copy() not idempotent: second run reported versions_copied=${String(second.value.versions_copied)}, data_objects_copied=${String(second.value.data_objects_copied)}`,
					);
				}

				const store_ids = [...new Set(specs.map((s) => s.store_id))];
				for (const store_id of store_ids) {
					const source_metas = canonical(await collect(source, store_id));
					const dest_metas = canonical(await collect(dest, store_id));
					if (!Bun.deepEquals(source_metas, dest_metas)) {
						throw new Error(
							`dest listing for store "${store_id}" diverges from source:\n  source: ${JSON.stringify(source_metas)}\n  dest:   ${JSON.stringify(dest_metas)}`,
						);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});
});
