import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_memory_backend } from "../../backend/memory.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations, define_observation_type } from "../../observations/index.js";
import { filter_observation_rows } from "../../observations/storage.js";
import type { ObservationRow } from "../../observations/schema.js";
import type { Backend, ObservationsClient } from "../../types";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";

const simple_type = define_observation_type("simple", z.object({ value: z.string() }));

const make_row = (id: string, version: string, created_at: string): ObservationRow => ({
	id,
	type: "simple",
	source_store_id: "docs",
	source_version: version,
	source_path: null,
	source_span_start: null,
	source_span_end: null,
	content: JSON.stringify({ value: id }),
	confidence: null,
	observed_at: null,
	created_at,
	derived_from: null,
	entity_key: null,
});

const backends: [string, () => Backend][] = [
	["memory", () => create_memory_backend()],
	[
		"cloudflare (drizzle)",
		() =>
			create_cloudflare_backend({ d1: create_fake_d1([corpus_snapshots, corpus_observations]), r2: create_fake_r2() }),
	],
];

const collect = async (observations: ObservationsClient, opts: Parameters<ObservationsClient["query"]>[0]) => {
	const values: string[] = [];
	for await (const obs of observations.query(opts)) {
		values.push((obs.content as { value: string }).value);
	}
	return values;
};

const put = (observations: ObservationsClient, store_id: string, version: string, value: string) =>
	observations.put(simple_type, { source: { store_id, version }, content: { value } });

describe.each(backends)("exclude_source_version - %s", (_name, make_backend) => {
	it("drops rows from the excluded version", async () => {
		const observations = make_backend().observations!;
		await put(observations, "docs", "v1", "a");
		await put(observations, "docs", "v2", "b");

		expect((await collect(observations, { exclude_source_version: "v2" })).toSorted()).toEqual(["a"]);
	});

	it("combines with source_store; limit 1 returns the newest previous observation", async () => {
		const observations = make_backend().observations!;
		await put(observations, "docs", "v1", "old");
		await new Promise((r) => setTimeout(r, 5));
		await put(observations, "docs", "v2", "newer");
		await new Promise((r) => setTimeout(r, 5));
		await put(observations, "other", "v9", "other-store");
		await new Promise((r) => setTimeout(r, 5));
		await put(observations, "docs", "v3", "current");

		const previous = await collect(observations, {
			type: "simple",
			source_store: "docs",
			exclude_source_version: "v3",
			limit: 1,
		});
		expect(previous).toEqual(["newer"]);
	});

	it("returns nothing extra when the excluded version matches no rows", async () => {
		const observations = make_backend().observations!;
		await put(observations, "docs", "v1", "a");

		expect(await collect(observations, { exclude_source_version: "nope" })).toEqual(["a"]);
	});
});

describe("same-ms ordering - JS adapters", () => {
	it("returns later-inserted rows first when created_at is identical", () => {
		const at = "2024-01-01T00:00:00.000Z";
		const rows = [make_row("a", "v1", at), make_row("b", "v1", at), make_row("c", "v1", at)];

		expect(filter_observation_rows(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
		expect(filter_observation_rows(rows, { limit: 1 }).map((r) => r.id)).toEqual(["c"]);
	});

	it("still orders by created_at before insertion order", () => {
		const rows = [make_row("a", "v1", "2024-01-02T00:00:00.000Z"), make_row("b", "v1", "2024-01-01T00:00:00.000Z")];

		expect(filter_observation_rows(rows).map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("applies exclude_source_version at the storage layer", () => {
		const at = "2024-01-01T00:00:00.000Z";
		const rows = [make_row("a", "v1", at), make_row("b", "v2", at)];

		expect(filter_observation_rows(rows, { exclude_source_version: "v2" }).map((r) => r.id)).toEqual(["a"]);
	});
});

describe("same-ms ordering - drizzle", () => {
	it("returns later-inserted rows first when created_at is identical", async () => {
		const backend = create_cloudflare_backend({
			d1: create_fake_d1([corpus_snapshots, corpus_observations]),
			r2: create_fake_r2(),
		});
		const at = "2024-01-01T00:00:00.000Z";
		// ids ascend against insertion order so an id-based tie-break would fail
		const applied = await backend.apply_batch!(
			["z", "y", "x"].map((id) => ({ type: "observation_put", row: make_row(`obs_${id}`, "v1", at) })),
		);
		expect(applied.ok).toBe(true);
		const ids: string[] = [];
		for await (const obs of backend.observations!.query({})) {
			ids.push(obs.id);
		}
		expect(ids).toEqual(["obs_x", "obs_y", "obs_z"]);
	});
});
