import { describe, it, expect, afterAll } from "bun:test";
import { z } from "zod";
import type { Backend, Corpus, Store } from "../../types";
import { create_corpus, define_store, json_codec } from "../../index.js";
import { define_observation_type, generate_observation_id, observation_id_schema } from "../../observations/index.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_file_backend } from "../../backend/file.js";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";
import { create_remote_backend } from "../../backend/remote.js";
import { corpus_snapshots } from "../../schema.js";
import { corpus_observations } from "../../observations/schema.js";
import { create_fake_d1, create_fake_r2 } from "../fakes/cloudflare.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";
import { make_tmp_dir, remove_tmp_dir } from "../support/tmp.js";

const doc_schema = z.object({ text: z.string() });
const note_type = define_observation_type("note", z.object({ text: z.string() }));
const source = { store_id: "docs", version: "v1" };

type Provider = {
	name: string;
	make: () => Promise<Backend> | Backend;
	atomic_tx: boolean;
};

const tmp_dirs: string[] = [];
const fakes: { d1: FakeD1HttpServer; s3: FakeS3Server }[] = [];

afterAll(async () => {
	for (const f of fakes) {
		f.d1.stop();
		f.s3.stop();
	}
	await Promise.all(tmp_dirs.map(remove_tmp_dir));
});

const providers: Provider[] = [
	{ name: "memory", make: () => create_memory_backend(), atomic_tx: true },
	{
		name: "file",
		make: async () => {
			const dir = await make_tmp_dir("obs-id");
			tmp_dirs.push(dir);
			return create_file_backend({ base_path: dir });
		},
		atomic_tx: true,
	},
	{
		name: "cloudflare",
		make: () =>
			create_cloudflare_backend({
				d1: create_fake_d1([corpus_snapshots, corpus_observations]),
				r2: create_fake_r2(),
			}),
		atomic_tx: true,
	},
	{
		name: "remote",
		make: () => {
			const d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
			const s3 = create_fake_s3();
			fakes.push({ d1, s3 });
			return create_remote_backend({
				account_id: "test-account",
				database_id: "test-database",
				api_token: "test-token",
				d1_base_url: d1.url,
				r2: {
					bucket: "test-bucket",
					access_key_id: "test-access-key-id",
					secret_access_key: "test-secret-access-key",
					endpoint: s3.url,
				},
			});
		},
		atomic_tx: false,
	},
];

const obs_of = (backend: Backend) => {
	if (!backend.observations) throw new Error("backend has no observations client");
	return backend.observations;
};

const collect = async (backend: Backend) => {
	const rows = [];
	for await (const row of obs_of(backend).query()) rows.push(row);
	return rows;
};

const make_corpus = (backend: Backend): Corpus<{ docs: Store<z.infer<typeof doc_schema>> }> =>
	create_corpus()
		.with_backend(backend)
		.with_store(define_store("docs", json_codec(doc_schema)))
		.with_observations([note_type])
		.build();

const bad_ids = ["", "abc", "obs_", "obs_has space", `obs_${"x".repeat(65)}`];

describe("generate_observation_id", () => {
	it("always satisfies observation_id_schema", () => {
		for (let i = 0; i < 100; i++) expect(observation_id_schema.safeParse(generate_observation_id()).success).toBe(true);
	});
});

for (const provider of providers) {
	describe(`caller-supplied observation ids - ${provider.name}`, () => {
		it("round-trips a valid id", async () => {
			const backend = await provider.make();
			const put = await obs_of(backend).put(note_type, { source, content: { text: "hi" }, id: "obs_mine-1" });
			expect(put.ok).toBe(true);
			if (!put.ok) return;
			expect(put.value.id).toBe("obs_mine-1");

			const got = await obs_of(backend).get("obs_mine-1");
			expect(got.ok).toBe(true);
			if (got.ok) expect(got.value.content).toEqual({ text: "hi" });
		});

		it("rejects malformed ids with validation_error and writes nothing", async () => {
			const backend = await provider.make();
			for (const id of bad_ids) {
				const put = await obs_of(backend).put(note_type, { source, content: { text: "hi" }, id });
				expect(put.ok).toBe(false);
				if (!put.ok) expect(put.error.kind).toBe("validation_error");
			}
			expect(await collect(backend)).toHaveLength(0);
		});

		it("rejects a repeated id with validation_error and keeps the original row", async () => {
			const backend = await provider.make();
			const first = await obs_of(backend).put(note_type, { source, content: { text: "original" }, id: "obs_dup" });
			expect(first.ok).toBe(true);

			const second = await obs_of(backend).put(note_type, { source, content: { text: "replacement" }, id: "obs_dup" });
			expect(second.ok).toBe(false);
			if (!second.ok) {
				expect(second.error.kind).toBe("validation_error");
				if (second.error.kind === "validation_error") expect(second.error.message).toContain("obs_dup");
			}

			const rows = await collect(backend);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.content).toEqual({ text: "original" });
		});

		it("tx.observe with a colliding id fails the transaction and the original row survives", async () => {
			const backend = await provider.make();
			await obs_of(backend).put(note_type, { source, content: { text: "original" }, id: "obs_tx" });
			const corpus = make_corpus(backend);

			const result = await corpus.transaction(async (tx) => {
				const snap = await tx.put(corpus.stores.docs, { text: "in tx" });
				if (!snap.ok) return snap;
				return tx.observe(note_type, {
					source: { store_id: "docs", version: snap.value.version },
					content: { text: "replacement" },
					id: "obs_tx",
				});
			});

			expect(result.ok).toBe(false);
			if (provider.atomic_tx && !result.ok) expect(result.error.kind).toBe("transaction_aborted");

			const rows = await collect(backend);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.content).toEqual({ text: "original" });

			if (provider.atomic_tx) {
				const listed = [];
				for await (const meta of backend.metadata.list("docs")) listed.push(meta);
				expect(listed).toHaveLength(0);
			}
		});
	});
}

describe("tx.observe id validation", () => {
	it("rejects a malformed id before touching the backend", async () => {
		const corpus = make_corpus(create_memory_backend());
		const result = await corpus.transaction(async (tx) =>
			tx.observe(note_type, { source, content: { text: "x" }, id: "bad" }),
		);
		expect(result.ok).toBe(false);
	});
});
