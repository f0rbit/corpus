import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import fc from "fast-check";
import { lookup, __reset_registry_for_tests } from "../../testing/index.js";
import { SNAPSHOT_META_BRAND, register } from "../../testing/register.js";
import { create_memory_backend } from "../../backend/memory.js";
import type { SnapshotMeta } from "../../types.js";

describe("property: backend metadata round-trip", () => {
	beforeAll(() => {
		__reset_registry_for_tests();
		register();
	});

	test("metadata put → get round-trip preserves all fields (memory backend)", async () => {
		const meta_arb = lookup(SNAPSHOT_META_BRAND);
		expect(meta_arb).toBeDefined();
		if (!meta_arb) return;

		await fc.assert(
			fc.asyncProperty(meta_arb, async (meta: SnapshotMeta) => {
				const backend = create_memory_backend();

				const put = await backend.metadata.put(meta);
				expect(put.ok).toBe(true);

				const got = await backend.metadata.get(meta.store_id, meta.version);
				expect(got.ok).toBe(true);
				if (!got.ok) return;

				const value = got.value;
				expect(value.store_id).toBe(meta.store_id);
				expect(value.version).toBe(meta.version);
				expect(value.content_hash).toBe(meta.content_hash);
				expect(value.content_type).toBe(meta.content_type);
				expect(value.size_bytes).toBe(meta.size_bytes);
				expect(value.data_key).toBe(meta.data_key);
				expect(value.created_at.getTime()).toBe(meta.created_at.getTime());
				if (meta.invoked_at === undefined) {
					expect(value.invoked_at).toBeUndefined();
				} else {
					expect(value.invoked_at?.getTime()).toBe(meta.invoked_at.getTime());
				}
				expect(value.parents).toEqual(meta.parents);
				expect(value.tags).toEqual(meta.tags);
			}),
			{ numRuns: 200 }
		);
	});
});
