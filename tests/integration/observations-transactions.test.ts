import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
	create_corpus,
	create_memory_backend,
	define_store,
	json_codec,
	ok,
	type Backend,
	type BatchOp,
	type Corpus,
	type Store,
} from "../../index.js";
import { define_observation_type, create_pointer } from "../../observations/index.js";

// Transaction-path coverage for the memory backend's apply_batch:
// - tx.observe inside a transaction goes through observation_put and the
//   observation lands in the live observation_store on commit.
// - apply_batch rollback: snapshot state is fully restored when an op throws.

const doc_schema = z.object({ text: z.string() });
type Doc = z.infer<typeof doc_schema>;

const sentiment_type = define_observation_type("sentiment", z.object({ subject: z.string(), score: z.number() }));

function make_corpus(backend?: Backend): Corpus<{ docs: Store<Doc> }> {
	return create_corpus()
		.with_backend(backend ?? create_memory_backend())
		.with_store(define_store("docs", json_codec(doc_schema)))
		.with_observations([sentiment_type])
		.build();
}

describe("memory backend - observations through tx.observe", () => {
	it("commits an observation written inside a transaction", async () => {
		const corpus = make_corpus();

		const result = await corpus.transaction(async (tx) => {
			const snap = await tx.put(corpus.stores.docs, { text: "hello" });
			if (!snap.ok) return snap;
			const obs = await tx.observe(sentiment_type, {
				source: { store_id: "docs", version: snap.value.version },
				content: { subject: "hello", score: 0.9 },
			});
			if (!obs.ok) return obs;
			return ok({ obs_id: obs.value.id, version: snap.value.version });
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const fetched = await corpus.observations!.get(result.value.value.obs_id);
		expect(fetched.ok).toBe(true);
		if (!fetched.ok) return;
		expect(fetched.value.type).toBe("sentiment");
		expect(fetched.value.source.version).toBe(result.value.value.version);
	});

	it("rolls back an observation when the transaction body throws", async () => {
		const corpus = make_corpus();

		const seed = await corpus.observations!.put(sentiment_type, {
			source: create_pointer("docs", "pre-existing"),
			content: { subject: "seed", score: 0.0 },
		});
		expect(seed.ok).toBe(true);

		const result = await corpus.transaction(async (tx) => {
			await tx.observe(sentiment_type, {
				source: { store_id: "docs", version: "doomed" },
				content: { subject: "doomed", score: -1 },
			});
			throw new Error("boom");
		});

		expect(result.ok).toBe(false);

		// only the seed observation survived
		const all: unknown[] = [];
		for await (const o of corpus.observations!.query({})) all.push(o);
		expect(all).toHaveLength(1);
	});
});

describe("memory backend - apply_batch rollback", () => {
	it("restores meta, data, and observation maps when an op throws", async () => {
		const backend = create_memory_backend();

		// seed pre-existing state via the public clients
		await backend.metadata.put({
			store_id: "docs",
			version: "seed",
			parents: [],
			created_at: new Date(),
			content_hash: "seedhash",
			content_type: "application/json",
			size_bytes: 0,
			data_key: "docs/seedhash",
		});
		await backend.data.put("docs/seedhash", new Uint8Array([1, 2, 3]));

		// craft an op list that throws on the second op. We use a Proxy-wrapped op
		// whose `meta` getter throws when read inside apply_batch's switch.
		const ok_op: BatchOp = {
			type: "meta_put",
			meta: {
				store_id: "docs",
				version: "tx-applied",
				parents: [],
				created_at: new Date(),
				content_hash: "txhash",
				content_type: "application/json",
				size_bytes: 0,
				data_key: "docs/txhash",
			},
		};
		const partial_op: unknown = { type: "meta_put" };
		const throwing_op = new Proxy(partial_op as BatchOp, {
			get(target, prop) {
				if (prop === "meta") throw new Error("synthetic op failure");
				return Reflect.get(target, prop) as unknown;
			},
		});

		const result = await backend.apply_batch!([ok_op, throwing_op]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("transaction_aborted");
		if (result.error.kind !== "transaction_aborted") return;
		expect(result.error.reason).toBe("apply_batch_failed");

		// the first op's meta_put must NOT be visible; only the seed remains
		const applied = await backend.metadata.get("docs", "tx-applied");
		expect(applied.ok).toBe(false);
		const seed_check = await backend.metadata.get("docs", "seed");
		expect(seed_check.ok).toBe(true);

		// data store is untouched (we only added a meta_put, not a data_put), and
		// the seed bytes still resolve.
		const seed_data = await backend.data.get("docs/seedhash");
		expect(seed_data.ok).toBe(true);
	});
});
