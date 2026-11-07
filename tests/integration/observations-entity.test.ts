import { describe, it, expect, afterAll } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_file_backend } from "../../backend/file.js";
import { create_memory_backend } from "../../backend/memory.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations, define_observation_type } from "../../observations/index.js";
import type { Backend, ObservationsClient, SnapshotMeta } from "../../types";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";

const price_type = define_observation_type("price", z.object({ amount: z.number() }));

const dirs: string[] = [];

const make_file_backend = async (): Promise<Backend> => {
	const dir = await mkdtemp(join(tmpdir(), "corpus-obs-entity-"));
	dirs.push(dir);
	return create_file_backend({ base_path: dir });
};

const backends: [string, () => Backend | Promise<Backend>][] = [
	["memory", () => create_memory_backend()],
	["file", make_file_backend],
	[
		"cloudflare (drizzle)",
		() =>
			create_cloudflare_backend({ d1: create_fake_d1([corpus_snapshots, corpus_observations]), r2: create_fake_r2() }),
	],
];

afterAll(async () => {
	await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

let clock = Date.parse("2024-01-01T00:00:00.000Z");

const put_snapshot = async (backend: Backend, version: string, entity_key?: string) => {
	clock += 1000;
	const meta: SnapshotMeta = {
		store_id: "pages",
		version,
		parents: [],
		created_at: new Date(clock),
		content_hash: `hash_${version}`,
		content_type: "application/json",
		size_bytes: 0,
		data_key: `pages/hash_${version}`,
		...(entity_key === undefined ? {} : { entity_key }),
	};
	const result = await backend.metadata.put(meta);
	expect(result.ok).toBe(true);
};

const source = (version: string) => ({ store_id: "pages", version });

const amounts = async (observations: ObservationsClient, opts: Parameters<ObservationsClient["query"]>[0]) => {
	const values: number[] = [];
	for await (const obs of observations.query(opts)) {
		values.push((obs.content as { amount: number }).amount);
	}
	return values;
};

describe.each(backends)("observation entity_key - %s", (_name, make_backend) => {
	it("inherits entity_key from the source snapshot", async () => {
		const backend = await make_backend();
		await put_snapshot(backend, "a1", "A");
		const put = await backend.observations!.put(price_type, { source: source("a1"), content: { amount: 1 } });

		expect(put.ok && put.value.entity_key).toBe("A");
		const got = await backend.observations!.get(put.ok ? put.value.id : "");
		expect(got.ok && got.value.entity_key).toBe("A");
	});

	it("explicit entity_key overrides the source snapshot's", async () => {
		const backend = await make_backend();
		await put_snapshot(backend, "a1", "A");
		const put = await backend.observations!.put(price_type, {
			source: source("a1"),
			content: { amount: 1 },
			entity_key: "Z",
		});

		expect(put.ok && put.value.entity_key).toBe("Z");
		expect(await amounts(backend.observations!, { entity_key: "Z" })).toEqual([1]);
		expect(await amounts(backend.observations!, { entity_key: "A" })).toEqual([]);
	});

	it("stores no key when the source is unkeyed, and omits it on round-trip", async () => {
		const backend = await make_backend();
		await put_snapshot(backend, "u1");
		const put = await backend.observations!.put(price_type, { source: source("u1"), content: { amount: 1 } });

		expect(put.ok && "entity_key" in put.value).toBe(false);
		const got = await backend.observations!.get(put.ok ? put.value.id : "");
		expect(got.ok && "entity_key" in got.value).toBe(false);
		expect(await amounts(backend.observations!, {})).toEqual([1]);
		expect(await amounts(backend.observations!, { entity_key: "A" })).toEqual([]);
	});

	it("put succeeds without a key when the source snapshot is missing", async () => {
		const backend = await make_backend();
		const put = await backend.observations!.put(price_type, { source: source("ghost"), content: { amount: 1 } });

		expect(put.ok).toBe(true);
		expect(put.ok && "entity_key" in put.value).toBe(false);
	});

	it("query filters by entity_key before limit with interleaved entities", async () => {
		const backend = await make_backend();
		await put_snapshot(backend, "a1", "A");
		await put_snapshot(backend, "b1", "B");
		const observations = backend.observations!;
		await observations.put(price_type, { source: source("a1"), content: { amount: 1 } });
		await new Promise((r) => setTimeout(r, 5));
		await observations.put(price_type, { source: source("b1"), content: { amount: 2 } });
		await new Promise((r) => setTimeout(r, 5));
		await observations.put(price_type, { source: source("b1"), content: { amount: 3 } });

		expect(await amounts(observations, { entity_key: "A", limit: 1 })).toEqual([1]);
		expect(await amounts(observations, { entity_key: "B", limit: 1 })).toEqual([3]);
		expect(await amounts(observations, { type: "price", entity_key: "B" })).toEqual([3, 2]);
	});

	it("query_meta carries entity_key", async () => {
		const backend = await make_backend();
		await put_snapshot(backend, "a1", "A");
		await backend.observations!.put(price_type, { source: source("a1"), content: { amount: 1 } });

		const keys: (string | undefined)[] = [];
		for await (const meta of backend.observations!.query_meta({ entity_key: "A" })) keys.push(meta.entity_key);
		expect(keys).toEqual(["A"]);
	});

	describe("is_stale", () => {
		it("a new snapshot of another entity does not stale a keyed pointer (#57 item 4)", async () => {
			const backend = await make_backend();
			await put_snapshot(backend, "a1", "A");
			await put_snapshot(backend, "b1", "B");

			expect(await backend.observations!.is_stale(source("a1"))).toBe(false);
		});

		it("a newer snapshot of the same entity stales the pointer", async () => {
			const backend = await make_backend();
			await put_snapshot(backend, "a1", "A");
			await put_snapshot(backend, "b1", "B");
			await put_snapshot(backend, "a2", "A");

			expect(await backend.observations!.is_stale(source("a1"))).toBe(true);
			expect(await backend.observations!.is_stale(source("a2"))).toBe(false);
		});

		it("unkeyed pointers use the store-wide rule", async () => {
			const backend = await make_backend();
			await put_snapshot(backend, "u1");
			await put_snapshot(backend, "u2");

			expect(await backend.observations!.is_stale(source("u1"))).toBe(true);
			expect(await backend.observations!.is_stale(source("u2"))).toBe(false);
		});

		it("a missing source falls back to the store-wide rule", async () => {
			const backend = await make_backend();
			expect(await backend.observations!.is_stale(source("ghost"))).toBe(false);

			await put_snapshot(backend, "a1", "A");
			expect(await backend.observations!.is_stale(source("ghost"))).toBe(true);
		});
	});
});
