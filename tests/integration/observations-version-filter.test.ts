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
import type { Backend, ObservationsClient } from "../../types";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";

const price_type = define_observation_type("price", z.object({ amount: z.number() }));

const dirs: string[] = [];

const make_file_backend = async (): Promise<Backend> => {
	const dir = await mkdtemp(join(tmpdir(), "corpus-obs-version-filter-"));
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

const versions = Array.from({ length: 10 }, (_, i) => `v${String(i)}`);
const oldest_three = ["v0", "v1", "v2"];

const seed = async (backend: Backend): Promise<ObservationsClient> => {
	const observations = backend.observations!;
	for (const [i, version] of versions.entries()) {
		const put = await observations.put(price_type, {
			source: { store_id: "pages", version },
			content: { amount: i },
		});
		expect(put.ok).toBe(true);
	}
	return observations;
};

type QueryOpts = NonNullable<Parameters<ObservationsClient["query"]>[0]>;

const source_versions = async (observations: ObservationsClient, opts: QueryOpts) => {
	const found: string[] = [];
	for await (const obs of observations.query(opts)) found.push(obs.source.version);
	return found;
};

const meta_versions = async (observations: ObservationsClient, opts: QueryOpts) => {
	const found: string[] = [];
	for await (const meta of observations.query_meta(opts)) found.push(meta.source.version);
	return found;
};

describe.each(backends)("version_filter with limit - %s", (_name, make_backend) => {
	it("Set filter applies before limit", async () => {
		const observations = await seed(await make_backend());
		const opts = { version_filter: new Set(oldest_three), limit: 2 };
		expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
		expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
	});

	it("array filter applies before limit", async () => {
		const observations = await seed(await make_backend());
		const opts = { version_filter: oldest_three, limit: 2 };
		expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
		expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
	});

	it("function filter applies before limit", async () => {
		const observations = await seed(await make_backend());
		const opts = { version_filter: (_store_id: string, version: string) => oldest_three.includes(version), limit: 2 };
		expect(await source_versions(observations, opts)).toEqual(["v2", "v1"]);
		expect(await meta_versions(observations, opts)).toEqual(["v2", "v1"]);
	});

	it("empty Set and array yield nothing", async () => {
		const observations = await seed(await make_backend());
		expect(await source_versions(observations, { version_filter: new Set<string>(), limit: 2 })).toEqual([]);
		expect(await source_versions(observations, { version_filter: [] })).toEqual([]);
		expect(await meta_versions(observations, { version_filter: new Set<string>() })).toEqual([]);
	});

	it("without a limit returns every match", async () => {
		const observations = await seed(await make_backend());
		expect((await source_versions(observations, { version_filter: new Set(oldest_three) })).toSorted()).toEqual(
			oldest_three,
		);
	});
});
