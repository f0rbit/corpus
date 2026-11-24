/**
 * `corpus.ts` transaction paths the backend contract suite can't reach: the
 * sequential commit fallback (backends without `apply_batch`) with its
 * compensating deletes, the tx handle's read-your-writes edges, and the
 * store-level error emits.
 *
 * Failures are injected with `with_faults`, a fail-after-N wrapper over the
 * in-memory backend (no mocks): the Nth call of a faulted op and every call
 * after it returns a `storage_error`.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { create_corpus, create_memory_backend, create_store, define_store, err, ok, text_codec } from "../../index.js";
import { define_observation_type } from "../../observations/index.js";
import type {
	Backend,
	Codec,
	Corpus,
	CorpusError,
	CorpusEvent,
	PutResult,
	Result,
	Store,
	TransactionHandle,
} from "../../types.js";

type Op = "metadata.put" | "metadata.get_latest" | "metadata.delete" | "data.put" | "data.get" | "data.delete";
type Plan = Partial<Record<Op, number>>;

const injected = (op: Op): CorpusError => ({
	kind: "storage_error",
	cause: new Error(`${op} injected`),
	operation: op,
});

function with_faults(base: Backend, plan: Plan, on_event?: (event: CorpusEvent) => void): Backend {
	const calls = new Map<Op, number>();
	const trips = (op: Op): boolean => {
		const seen = calls.get(op) ?? 0;
		calls.set(op, seen + 1);
		const allowed = plan[op];
		return allowed !== undefined && seen >= allowed;
	};
	return {
		...base,
		on_event,
		apply_batch: undefined,
		metadata: {
			...base.metadata,
			put: (meta) => (trips("metadata.put") ? Promise.resolve(err(injected("metadata.put"))) : base.metadata.put(meta)),
			delete: (store_id, version) =>
				trips("metadata.delete")
					? Promise.resolve(err(injected("metadata.delete")))
					: base.metadata.delete(store_id, version),
			get_latest: (store_id, opts) =>
				trips("metadata.get_latest")
					? Promise.resolve(err(injected("metadata.get_latest")))
					: base.metadata.get_latest(store_id, opts),
		},
		data: {
			...base.data,
			put: (data_key, data) =>
				trips("data.put") ? Promise.resolve(err(injected("data.put"))) : base.data.put(data_key, data),
			get: (data_key) => (trips("data.get") ? Promise.resolve(err(injected("data.get"))) : base.data.get(data_key)),
			delete: (data_key) =>
				trips("data.delete") ? Promise.resolve(err(injected("data.delete"))) : base.data.delete(data_key),
		},
	};
}

function value_of<T>(result: Result<T, CorpusError>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
	return result.value;
}

function error_of<K extends CorpusError["kind"]>(
	result: Result<unknown, CorpusError>,
	kind: K,
): Extract<CorpusError, { kind: K }> {
	if (result.ok) throw new Error(`expected ${kind}, got ok`);
	if (result.error.kind !== kind) throw new Error(`expected ${kind}, got ${result.error.kind}`);
	return result.error as Extract<CorpusError, { kind: K }>;
}

const notes = define_store("notes", text_codec());
const note_schema = z.object({ text: z.string() });
const note_type = define_observation_type("note_obs", note_schema);
const loose_note_type = define_observation_type<unknown>("note_obs", note_schema);

function build(backend: Backend) {
	return create_corpus().with_backend(backend).with_store(notes).with_observations([note_type]).build();
}

async function collect_versions(backend: Backend, store_id: string): Promise<string[]> {
	const versions: string[] = [];
	for await (const meta of backend.metadata.list(store_id)) versions.push(meta.version);
	return versions;
}

/** Run `f` in a committed tx and hand back its (possibly failing) inner Result. */
async function in_tx<T>(
	corpus: Pick<Corpus, "transaction">,
	f: (tx: TransactionHandle) => Promise<Result<T, CorpusError>>,
): Promise<Result<T, CorpusError>> {
	const result = await corpus.transaction(async (tx) => ok(await f(tx)));
	return value_of(result).value;
}

describe("transaction sequential fallback (no apply_batch)", () => {
	it("compensates the applied ops when a later put fails", async () => {
		const base = create_memory_backend();
		const corpus = build(with_faults(base, { "metadata.put": 1 }));
		const puts: PutResult[] = [];

		const result = await corpus.transaction(async (tx) => {
			const a = await tx.put(corpus.stores.notes, "a");
			if (!a.ok) return a;
			puts.push(a.value);
			const b = await tx.put(corpus.stores.notes, "b");
			if (!b.ok) return b;
			puts.push(b.value);
			return ok(null);
		});

		const aborted = error_of(result, "transaction_aborted");
		expect(aborted.reason).toBe("apply_batch_failed");
		expect(aborted.cause?.message).toBe("metadata.put injected");
		expect(puts).toHaveLength(2);
		expect(await collect_versions(base, "notes")).toEqual([]);
		expect(await Promise.all(puts.map((p) => base.data.exists(p.data_key)))).toEqual([false, false]);
	});

	it("reports partial_commit when an applied meta_delete can't be undone", async () => {
		const base = create_memory_backend();
		const seeded = value_of(await build(base).stores.notes.put("seed"));
		const corpus = build(with_faults(base, { "metadata.put": 0 }));
		const puts: PutResult[] = [];

		const result = await corpus.transaction(async (tx) => {
			const removed = await tx.delete(corpus.stores.notes, seeded.version);
			if (!removed.ok) return removed;
			const fresh = await tx.put(corpus.stores.notes, "fresh");
			if (!fresh.ok) return fresh;
			puts.push(fresh.value);
			return ok(null);
		});

		const partial = error_of(result, "partial_commit");
		expect(partial.ops_completed).toBe(2);
		expect(partial.ops_failed).toBe(1);
		expect(partial.cause.message).toBe("metadata.put injected");
		expect((await base.metadata.get("notes", seeded.version)).ok).toBe(false);
		expect(await Promise.all(puts.map((p) => base.data.exists(p.data_key)))).toEqual([false]);
	});

	it("reports partial_commit with the compensation error when an undo delete fails", async () => {
		const base = create_memory_backend();
		const corpus = build(with_faults(base, { "metadata.put": 1, "metadata.delete": 0 }));
		const puts: PutResult[] = [];

		const result = await corpus.transaction(async (tx) => {
			const a = await tx.put(corpus.stores.notes, "a");
			if (!a.ok) return a;
			puts.push(a.value);
			const b = await tx.put(corpus.stores.notes, "b");
			if (!b.ok) return b;
			return ok(null);
		});

		const partial = error_of(result, "partial_commit");
		expect(partial.ops_completed).toBe(3);
		expect(partial.ops_failed).toBe(1);
		expect(partial.cause.message).toBe("metadata.delete injected");
		expect(await collect_versions(base, "notes")).toEqual(puts.map((p) => p.version));
	});

	it("aborts a tx.observe because the fallback can't apply observation ops", async () => {
		const base = create_memory_backend();
		const seeded = value_of(await build(base).stores.notes.put("seed"));
		const corpus = build(with_faults(base, {}));

		const result = await corpus.transaction(async (tx) => {
			const observed = await tx.observe(note_type, {
				source: { store_id: "notes", version: seeded.version },
				content: { text: "hi" },
			});
			return observed.ok ? ok(null) : observed;
		});

		const aborted = error_of(result, "transaction_aborted");
		expect(aborted.reason).toBe("apply_batch_failed");
		expect(aborted.cause?.message).toContain("require backend.apply_batch");
	});

	it("aborts a tx.observation_delete the same way", async () => {
		const corpus = build(with_faults(create_memory_backend(), {}));

		const result = await corpus.transaction(async (tx) => {
			const removed = await tx.observation_delete("obs_gone");
			return removed.ok ? ok(null) : removed;
		});

		const aborted = error_of(result, "transaction_aborted");
		expect(aborted.reason).toBe("apply_batch_failed");
		expect(aborted.cause?.message).toContain("require backend.apply_batch");
	});
});

describe("transaction handle reads and validation", () => {
	it("get_latest returns not_found for a store with nothing in it", async () => {
		const corpus = build(create_memory_backend());
		const latest = await in_tx(corpus, (tx) => tx.get_latest(corpus.stores.notes));
		const missing = error_of(latest, "not_found");
		expect(missing.version).toBe("latest");
	});

	it("get_latest prefers a buffered put over the live latest", async () => {
		const corpus = build(create_memory_backend());
		value_of(await corpus.stores.notes.put("old"));
		const latest = await in_tx(corpus, async (tx) => {
			const put = await tx.put(corpus.stores.notes, "new");
			if (!put.ok) return put;
			return tx.get_latest(corpus.stores.notes);
		});
		expect(value_of(latest).data).toBe("new");
	});

	it("get_latest skips a version deleted in the same tx", async () => {
		const corpus = build(create_memory_backend());
		value_of(await corpus.stores.notes.put("one"));
		const two = value_of(await corpus.stores.notes.put("two"));
		const latest = await in_tx(corpus, async (tx) => {
			await tx.delete(corpus.stores.notes, two.version);
			return tx.get_latest(corpus.stores.notes);
		});
		expect(value_of(latest).data).toBe("one");
	});

	it("get_latest is not_found once every version is deleted in the tx", async () => {
		const corpus = build(create_memory_backend());
		const only = value_of(await corpus.stores.notes.put("only"));
		const latest = await in_tx(corpus, async (tx) => {
			await tx.delete(corpus.stores.notes, only.version);
			return tx.get_latest(corpus.stores.notes);
		});
		expect(error_of(latest, "not_found").version).toBe("latest");
	});

	it("get reads live data for a buffered put that deduplicated against a committed blob", async () => {
		const corpus = build(create_memory_backend());
		const first = value_of(await corpus.stores.notes.put("same"));
		const snapshot = await in_tx(corpus, async (tx) => {
			const put = await tx.put(corpus.stores.notes, "same");
			if (!put.ok) return put;
			expect(put.value.deduplicated).toBe(true);
			expect(put.value.data_key).toBe(first.data_key);
			return tx.get(corpus.stores.notes, put.value.version);
		});
		expect(value_of(snapshot).data).toBe("same");
	});

	it("put to a store not registered on the corpus is invalid_config", async () => {
		const base = create_memory_backend();
		const corpus = build(base);
		const other = create_store(base, define_store("other", text_codec()));
		const put = await in_tx(corpus, (tx) => tx.put(other, "x"));
		expect(error_of(put, "invalid_config").message).toContain("'other' is not registered");
	});

	it("put uses the store's data_key_fn for new data", async () => {
		const base = create_memory_backend();
		const keyed = define_store("keyed", text_codec(), { data_key_fn: (ctx) => `custom/${ctx.content_hash}` });
		const corpus = create_corpus().with_backend(base).with_store(keyed).build();
		const committed = await corpus.transaction((tx) => tx.put(corpus.stores.keyed, "k"));
		const meta = value_of(committed).value;
		expect(meta.data_key).toBe(`custom/${meta.content_hash}`);
		expect(await base.data.exists(meta.data_key)).toBe(true);
	});

	it("observe with invalid content is a validation_error", async () => {
		const corpus = build(create_memory_backend());
		const seeded = value_of(await corpus.stores.notes.put("seed"));
		const observed = await in_tx(corpus, (tx) =>
			tx.observe(loose_note_type, { source: { store_id: "notes", version: seeded.version }, content: { text: 1 } }),
		);
		error_of(observed, "validation_error");
	});
});

const failing_codec: Codec<string> = {
	...text_codec(),
	encode: () => Promise.reject(new Error("encode boom")),
	encode_stream: () => {
		throw new Error("encode_stream boom");
	},
};

const stream_of = (chunk: string) =>
	new ReadableStream<string>({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});

type EmitCase = {
	name: string;
	kind: CorpusError["kind"];
	plan?: Plan;
	codec?: Codec<string>;
	call: (store: Store<string>, seeded_version: string) => Promise<Result<unknown, CorpusError>>;
};

const emit_cases: EmitCase[] = [
	{ name: "put with a throwing encode", kind: "encode_error", codec: failing_codec, call: (s) => s.put("x") },
	{
		name: "put_stream with a throwing encode_stream",
		kind: "encode_error",
		codec: failing_codec,
		call: (s) => s.put_stream(stream_of("x")),
	},
	{ name: "put when data.put fails", kind: "storage_error", plan: { "data.put": 0 }, call: (s) => s.put("fresh") },
	{
		name: "put when metadata.put fails",
		kind: "storage_error",
		plan: { "metadata.put": 0 },
		call: (s) => s.put("fresh"),
	},
	{
		name: "put if_changed when get_latest fails",
		kind: "storage_error",
		plan: { "metadata.get_latest": 0 },
		call: (s) => s.put("fresh", { if_changed: true }),
	},
	{ name: "get when data.get fails", kind: "storage_error", plan: { "data.get": 0 }, call: (s, v) => s.get(v) },
	{
		name: "get_handle when data.get fails",
		kind: "storage_error",
		plan: { "data.get": 0 },
		call: (s, v) => s.get_handle(v),
	},
	{
		name: "get_latest_handle when data.get fails",
		kind: "storage_error",
		plan: { "data.get": 0 },
		call: (s) => s.get_latest_handle(),
	},
];

describe("store operations emit an error event alongside the error Result", () => {
	for (const c of emit_cases) {
		it(c.name, async () => {
			const base = create_memory_backend();
			const seeded = value_of(await create_store(base, define_store("s", text_codec())).put("seed"));
			const events: CorpusEvent[] = [];
			const faulty = with_faults(base, c.plan ?? {}, (event) => {
				events.push(event);
			});
			const store = create_store(faulty, define_store("s", c.codec ?? text_codec()));

			const result = await c.call(store, seeded.version);

			expect(error_of(result, c.kind).kind).toBe(c.kind);
			expect(events.flatMap((e) => (e.type === "error" ? [e.error.kind] : []))).toContain(c.kind);
		});
	}
});
