import { describe, it, expect } from "bun:test";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { collect_listing, with_error_tracking } from "../../listing.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations } from "../../observations/index.js";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import type { CorpusEvent, SnapshotMeta } from "../../types.js";

const make_meta = (version: string): SnapshotMeta => ({
	store_id: "items",
	version,
	parents: [],
	created_at: new Date(),
	content_hash: `hash_${version}`,
	content_type: "application/json",
	size_bytes: 0,
	data_key: `items/hash_${version}`,
});

const setup = (forward?: (event: CorpusEvent) => void) => {
	const d1 = create_fake_d1([corpus_snapshots, corpus_observations]);
	const { on_event, tracker } = with_error_tracking(forward);
	const backend = create_cloudflare_backend({ d1, r2: create_fake_r2(), on_event });
	return { d1, backend, tracker };
};

async function* one_item(): AsyncIterable<number> {
	yield 1;
}

describe("collect_listing", () => {
	it("returns the items of a healthy listing", async () => {
		const { backend, tracker } = setup();
		await backend.metadata.put(make_meta("v1"));
		await backend.metadata.put(make_meta("v2"));

		const listed = await collect_listing(tracker, backend.metadata.list("items"));

		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value.map((m) => m.version).toSorted()).toEqual(["v1", "v2"]);
	});

	it("fails with the recorded storage_error when D1 fails mid-listing", async () => {
		const { d1, backend, tracker } = setup();
		d1.sqlite.close();

		const listed = await collect_listing(tracker, backend.metadata.list("items"));

		expect(listed.ok).toBe(false);
		if (listed.ok) return;
		expect(listed.error.kind).toBe("storage_error");
	});

	it("only reports errors recorded during the iteration it wraps", async () => {
		const { d1, backend, tracker } = setup();
		d1.sqlite.close();
		await backend.metadata.get("items", "v1");
		expect(tracker.errors.length).toBeGreaterThan(0);

		const listed = await collect_listing(tracker, one_item());

		expect(listed.ok).toBe(true);
	});

	it("collects plainly, masking failures, when there is no tracker", async () => {
		const { d1, backend } = setup();
		d1.sqlite.close();

		const listed = await collect_listing(undefined, backend.metadata.list("items"));

		expect(listed.ok).toBe(true);
		if (!listed.ok) return;
		expect(listed.value).toEqual([]);
	});

	it("forwards every event to the wrapped handler", async () => {
		const events: CorpusEvent[] = [];
		const { d1, backend, tracker } = setup((event) => {
			events.push(event);
		});
		d1.sqlite.close();

		await collect_listing(tracker, backend.metadata.list("items"));

		expect(events.some((e) => e.type === "error")).toBe(true);
	});
});
