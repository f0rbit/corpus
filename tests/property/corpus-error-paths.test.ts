import { describe, test, beforeAll } from "bun:test";
import { z } from "zod";
import { law } from "../../testing/index.js";
import { CORPUS_ERROR_BRAND, register } from "../../testing/register.js";
import { __reset_registry_for_tests } from "../../testing/registry.js";
import { create_memory_backend } from "../../backend/memory.js";
import { create_corpus } from "../../corpus.js";
import { define_store, ok, err } from "../../types.js";
import { json_codec, compute_hash } from "../../utils.js";
import type { Backend, CorpusError, Result, SnapshotMeta } from "../../types.js";

const DocSchema = z.object({ id: z.string(), value: z.number() });
type Doc = z.infer<typeof DocSchema>;

const STORE_ID = "docs";
const SEEDED_VERSION = "v-under-test";

/**
 * Describes how to pre-seed the backend so the subsequent get surfaces a
 * specific error variant. This is the pilot's `Args` — the provoke table
 * maps each generated failure onto one of these.
 */
type SetupSpec =
	| { kind: "not_found"; version: string }
	| { kind: "decode_error"; corruption: string }
	| { kind: "hash_mismatch"; recorded_hash: string; doc: Doc };

function flip_first_char(hash: string): string {
	return (hash[0] === "a" ? "b" : "a") + hash.slice(1);
}

async function seed_snapshot(backend: Backend, bytes: Uint8Array, content_hash: string): Promise<void> {
	const data_key = `${STORE_ID}/${content_hash}`;
	const data_put = await backend.data.put(data_key, bytes);
	if (!data_put.ok) throw new Error(`seed: data.put failed (${data_put.error.kind})`);

	const meta: SnapshotMeta = {
		store_id: STORE_ID,
		version: SEEDED_VERSION,
		parents: [],
		created_at: new Date(),
		content_hash,
		content_type: "application/json",
		size_bytes: bytes.length,
		data_key,
	};
	const meta_put = await backend.metadata.put(meta);
	if (!meta_put.ok) throw new Error(`seed: metadata.put failed (${meta_put.error.kind})`);
}

async function seed(backend: Backend, spec: SetupSpec): Promise<string> {
	if (spec.kind === "not_found") return spec.version;

	if (spec.kind === "decode_error") {
		// Bytes guaranteed to be invalid JSON (JSON.parse chokes on `not-json...`)
		// but recorded under their REAL content hash, so hash verification passes
		// and decode is the first failure on the read path.
		const bytes = new TextEncoder().encode(`not-json ${spec.corruption}`);
		await seed_snapshot(backend, bytes, await compute_hash(bytes));
		return SEEDED_VERSION;
	}

	// hash_mismatch: valid JSON bytes, but metadata records a hash that is
	// deliberately NOT the hash of those bytes. The flip guard removes the
	// astronomically-unlikely random collision so the property never flakes.
	const bytes = new TextEncoder().encode(JSON.stringify(spec.doc));
	const actual = await compute_hash(bytes);
	const recorded = spec.recorded_hash === actual ? flip_first_char(spec.recorded_hash) : spec.recorded_hash;
	await seed_snapshot(backend, bytes, recorded);
	return SEEDED_VERSION;
}

/**
 * The fn under test — the runnable spec for which CorpusError variants the
 * store-get read path emits. Drives the real `store.get_handle` path
 * (metadata lookup → data fetch → decode) plus content-hash verification
 * against `meta.content_hash`. Ordering matters: hash verification runs
 * BEFORE decode, so corrupt-but-correctly-hashed bytes surface `decode_error`
 * while wrongly-hashed bytes surface `hash_mismatch`.
 */
async function get_store_version(spec: SetupSpec): Promise<Result<{ meta: SnapshotMeta; data: Doc }, CorpusError>> {
	const backend = create_memory_backend();
	const corpus = create_corpus()
		.with_backend(backend)
		.with_store(define_store(STORE_ID, json_codec(DocSchema)))
		.build();

	const version = await seed(backend, spec);

	const handle_result = await corpus.stores[STORE_ID].get_handle(version);
	if (!handle_result.ok) return handle_result;

	const { meta, handle } = handle_result.value;
	const bytes_result = await handle.bytes();
	if (!bytes_result.ok) return bytes_result;

	const actual_hash = await compute_hash(bytes_result.value);
	if (actual_hash !== meta.content_hash) {
		return err({ kind: "hash_mismatch", expected: meta.content_hash, actual: actual_hash });
	}

	const value_result = await handle.value();
	if (!value_result.ok) return value_result;

	return ok({ meta, data: value_result.value });
}

/**
 * Provoke stub for variants the get path cannot surface. Never invoked at
 * runtime (the variants are scoped out via `only`) but required by the mapped
 * provoke type — which is the point: adding a 13th CorpusError variant makes
 * this table a compile error until someone decides whether the get path can
 * surface it.
 */
const cannot_surface = (kind: CorpusError["kind"]) => (): [SetupSpec] => {
	throw new Error(`store.get cannot surface '${kind}' — scoped out via \`only\``);
};

describe("property: corpus error paths (store.get, memory backend)", () => {
	beforeAll(() => {
		__reset_registry_for_tests();
		register();
	});

	test("error_path_exhaustive: not_found, decode_error, hash_mismatch each fire with matching kind", async () => {
		await law.error_path_exhaustive(get_store_version, {
			error_brand: CORPUS_ERROR_BRAND,
			provoke: {
				not_found: (f) => [{ kind: "not_found", version: f.version }],
				decode_error: (f) => [{ kind: "decode_error", corruption: f.cause.message }],
				hash_mismatch: (f) => [
					{ kind: "hash_mismatch", recorded_hash: f.expected, doc: { id: f.actual, value: f.actual.length } },
				],
				already_exists: cannot_surface("already_exists"),
				storage_error: cannot_surface("storage_error"),
				encode_error: cannot_surface("encode_error"),
				invalid_config: cannot_surface("invalid_config"),
				validation_error: cannot_surface("validation_error"),
				observation_not_found: cannot_surface("observation_not_found"),
				transaction_aborted: cannot_surface("transaction_aborted"),
				partial_commit: cannot_surface("partial_commit"),
				concurrent_modification: cannot_surface("concurrent_modification"),
			},
			only: ["not_found", "decode_error", "hash_mismatch"],
			numRuns: 200,
		});
	}, 30000);
});
