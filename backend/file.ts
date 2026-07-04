/**
 * @module Backends
 * @description File-system storage backend for local persistence.
 */

import type { Backend, BatchOp, CorpusError, Result, SnapshotMeta, EventHandler } from "../types.js";
import type { ObservationRow } from "../observations/index.js";
import { create_observations_client, create_observations_storage } from "../observations/index.js";
import { create_emitter, parse_snapshot_meta } from "../utils.js";
import { ok, err } from "../types.js";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { create_metadata_client, create_data_client } from "./base.js";
import { try_catch_async } from "../result.js";
import type { MetadataStorage, DataStorage } from "./base.js";

/** Prefix used for transaction staging directories (`<base>/.tx-<id>/`). */
const TX_DIR_PREFIX = ".tx-";

function to_error(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

export type FileBackendConfig = {
	base_path: string;
	on_event?: EventHandler;
};

/**
 * Creates a file-system storage backend for local persistence.
 * @category Backends
 * @group Storage Backends
 *
 * Uses Bun's file APIs for efficient I/O. Metadata is stored as JSON files
 * per store, and data is stored as binary files in a shared `_data` directory.
 *
 * Directory structure:
 * ```
 * base_path/
 *   <store_id>/_meta.json     # Metadata for each store
 *   _data/<store_id>_<hash>.bin  # Binary data files
 * ```
 *
 * @param config - Configuration with `base_path` (root directory) and optional `on_event` handler
 * @returns A Backend instance using file-system storage
 *
 * @example
 * ```ts
 * const backend = create_file_backend({
 *   base_path: './data/corpus',
 *   on_event: (e) => console.log(e.type)
 * })
 *
 * const corpus = create_corpus()
 *   .with_backend(backend)
 *   .with_store(define_store('documents', json_codec(DocSchema)))
 *   .build()
 * ```
 */
export function create_file_backend(config: FileBackendConfig): Backend {
	const { base_path, on_event } = config;
	const emit = create_emitter(on_event);

	function meta_path(store_id: string): string {
		return join(base_path, store_id, "_meta.json");
	}

	function data_path(data_key: string): string {
		return join(base_path, "_data", `${data_key.replace(/\//g, "_")}.bin`);
	}

	async function read_store_meta(store_id: string): Promise<Map<string, SnapshotMeta>> {
		const path = meta_path(store_id);
		const file = Bun.file(path);
		if (!(await file.exists())) return new Map();

		const parsed = await try_catch_async(
			async () => {
				const content = await file.text();
				const entries = JSON.parse(content) as [string, Parameters<typeof parse_snapshot_meta>[0]][];
				return new Map(entries.map(([key, raw]) => [key, parse_snapshot_meta(raw)]));
			},
			() => null,
		);
		return parsed.ok ? parsed.value : new Map();
	}

	async function write_store_meta(store_id: string, meta_map: Map<string, SnapshotMeta>): Promise<void> {
		const path = meta_path(store_id);
		await mkdir(dirname(path), { recursive: true });
		const entries = Array.from(meta_map.entries());
		await Bun.write(path, JSON.stringify(entries));
	}

	async function* list_all_stores(): AsyncIterable<string> {
		const entries = await try_catch_async(
			() => readdir(base_path, { withFileTypes: true }),
			() => null,
		);
		if (!entries.ok) return;
		for (const entry of entries.value) {
			// Skip `_*` (internal: `_data`, `_observations.json`) and `.*`
			// (transaction staging dirs `.tx-<id>/`).
			if (entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith(".")) {
				yield entry.name;
			}
		}
	}

	const metadata_storage: MetadataStorage = {
		async get(store_id, version) {
			const store_meta = await read_store_meta(store_id);
			return store_meta.get(version) ?? null;
		},

		async put(meta) {
			const store_meta = await read_store_meta(meta.store_id);
			store_meta.set(meta.version, meta);
			await write_store_meta(meta.store_id, store_meta);
		},

		async delete(store_id, version) {
			const store_meta = await read_store_meta(store_id);
			store_meta.delete(version);
			await write_store_meta(store_id, store_meta);
		},

		async *list(store_id) {
			if (store_id) {
				const store_meta = await read_store_meta(store_id);
				for (const meta of store_meta.values()) {
					yield meta;
				}
			} else {
				for await (const sid of list_all_stores()) {
					const store_meta = await read_store_meta(sid);
					for (const meta of store_meta.values()) {
						yield meta;
					}
				}
			}
		},

		async find_by_hash(store_id, content_hash) {
			const store_meta = await read_store_meta(store_id);
			for (const meta of store_meta.values()) {
				if (meta.content_hash === content_hash) {
					return meta;
				}
			}
			return null;
		},
	};

	const data_storage: DataStorage = {
		async get(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			if (!(await file.exists())) return null;
			return {
				bytes: async () => new Uint8Array(await file.arrayBuffer()),
				stream: () => file.stream(),
				size: file.size,
			};
		},

		async put(data_key, data) {
			const path = data_path(data_key);
			await mkdir(dirname(path), { recursive: true });
			await Bun.write(path, data);
		},

		async delete(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			if (await file.exists()) {
				await file.delete();
			}
		},

		async exists(data_key) {
			const path = data_path(data_key);
			const file = Bun.file(path);
			return file.exists();
		},
	};

	const metadata = create_metadata_client(metadata_storage, emit);
	const data = create_data_client(data_storage, emit);

	const file_path = join(base_path, "_observations.json");

	async function read_observations(): Promise<ObservationRow[]> {
		const file = Bun.file(file_path);
		if (!(await file.exists())) return [];
		const rows = await try_catch_async(
			() => file.json() as Promise<ObservationRow[]>,
			() => null,
		);
		return rows.ok ? rows.value : [];
	}

	async function write_observations(rows: ObservationRow[]): Promise<void> {
		await Bun.write(file_path, JSON.stringify(rows, null, 2));
	}

	const storage = create_observations_storage({
		get_all: read_observations,
		set_all: write_observations,
		get_one: async (id) => {
			const rows = await read_observations();
			return rows.find((r) => r.id === id) ?? null;
		},
		add_one: async (row) => {
			const rows = await read_observations();
			rows.push(row);
			await write_observations(rows);
		},
		remove_one: async (id) => {
			const rows = await read_observations();
			const idx = rows.findIndex((r) => r.id === id);
			if (idx === -1) return false;
			rows.splice(idx, 1);
			await write_observations(rows);
			return true;
		},
	});
	const observations = create_observations_client(storage, metadata);

	/**
	 * Atomically apply a batch of ops via stage-and-rename.
	 *
	 * Staging phase: builds the post-commit state for every affected store's
	 * meta map, every staged data file, and (if any observation op exists) the
	 * post-commit observations array, all under `<base>/.tx-<id>/`. If any
	 * staging step fails, the whole staging dir is removed and the live tree
	 * is untouched — readers see no partial state.
	 *
	 * Commit phase: renames staged files over the live targets. Order is
	 * data → meta → observations so any committed metadata always has its
	 * blob present (matches the existing non-transactional ordering in
	 * `create_store`). Renames are atomic per-file on POSIX/NTFS but the
	 * batch of renames is NOT atomic across files — a crash mid-commit can
	 * leave some renames applied. The staging dir is left in place if a
	 * rename fails so `recover()` can clean it up; `partial_commit` is
	 * returned with the staging path in the cause.
	 *
	 * Best-effort durability — Bun's fs API does not expose `fsync`, so we
	 * rely on kernel-level guarantees only.
	 */
	async function apply_batch(ops: BatchOp[]): Promise<Result<void, CorpusError>> {
		const tx_id = crypto.randomUUID();
		const tx_dir = join(base_path, `${TX_DIR_PREFIX}${tx_id}`);
		const staged_meta_dir = join(tx_dir, "meta");
		const staged_data_dir = join(tx_dir, "data");
		const staged_obs_path = join(tx_dir, "_observations.json");

		try {
			await mkdir(tx_dir, { recursive: true });

			// Bucket meta ops per store so we read/merge each store's _meta.json
			// only once (one staged write per affected store, not per op).
			const meta_changes = new Map<string, { puts: SnapshotMeta[]; deletes: string[] }>();
			const data_writes: { staged: string; live: string }[] = [];
			let touches_observations = false;
			const obs_puts: ObservationRow[] = [];
			const obs_deletes: string[] = [];

			function meta_bucket(store_id: string): { puts: SnapshotMeta[]; deletes: string[] } {
				let bucket = meta_changes.get(store_id);
				if (!bucket) {
					bucket = { puts: [], deletes: [] };
					meta_changes.set(store_id, bucket);
				}
				return bucket;
			}

			// Pass 1: stage data + collect meta/obs ops.
			for (const op of ops) {
				switch (op.type) {
					case "meta_put":
						meta_bucket(op.meta.store_id).puts.push(op.meta);
						break;
					case "meta_delete":
						meta_bucket(op.store_id).deletes.push(op.version);
						break;
					case "data_put": {
						const live = data_path(op.data_key);
						const staged = join(staged_data_dir, `${op.data_key.replace(/\//g, "_")}.bin`);
						await mkdir(dirname(staged), { recursive: true });
						await Bun.write(staged, op.bytes);
						data_writes.push({ staged, live });
						break;
					}
					case "observation_put":
						touches_observations = true;
						obs_puts.push(op.row);
						break;
					case "observation_delete":
						touches_observations = true;
						obs_deletes.push(op.id);
						break;
				}
			}

			// Pass 2: build merged meta maps per affected store and stage them.
			const meta_writes: { staged: string; live: string }[] = [];
			for (const [store_id, bucket] of meta_changes) {
				const live = meta_path(store_id);
				const staged = join(staged_meta_dir, `${store_id}.json`);
				const merged = await read_store_meta(store_id);
				for (const meta of bucket.puts) merged.set(meta.version, meta);
				for (const version of bucket.deletes) merged.delete(version);
				await mkdir(dirname(staged), { recursive: true });
				await Bun.write(staged, JSON.stringify(Array.from(merged.entries())));
				meta_writes.push({ staged, live });
			}

			// Pass 3: build merged observations array if touched, stage it.
			let obs_write: { staged: string; live: string } | null = null;
			if (touches_observations) {
				const merged = await read_observations();
				const delete_set = new Set(obs_deletes);
				const filtered = merged.filter((r) => !delete_set.has(r.id));
				const final = filtered.concat(obs_puts);
				await Bun.write(staged_obs_path, JSON.stringify(final, null, 2));
				obs_write = { staged: staged_obs_path, live: file_path };
			}

			// Commit phase. Data first (idempotent — content-addressed), then
			// meta (the source of truth for visibility), then observations.
			// Mid-flight failure leaves the staging dir for `recover()`.
			const renames: { staged: string; live: string }[] = [
				...data_writes,
				...meta_writes,
				...(obs_write ? [obs_write] : []),
			];

			let committed = 0;
			for (const { staged, live } of renames) {
				try {
					await mkdir(dirname(live), { recursive: true });
					await rename(staged, live);
					committed++;
				} catch (cause) {
					return err({
						kind: "partial_commit",
						ops_completed: committed,
						ops_failed: renames.length - committed,
						cause:
							cause instanceof Error
								? new Error(`${cause.message} (staging dir: ${tx_dir})`, { cause })
								: new Error(`apply_batch rename failed (staging dir: ${tx_dir})`),
					});
				}
			}

			// All renames succeeded — clean up the now-empty staging tree.
			await rm(tx_dir, { recursive: true, force: true });
			return ok(undefined);
		} catch (cause) {
			// Staging-phase failure: nothing was visible to readers, so this
			// is a clean abort. Nuke the staging dir.
			await rm(tx_dir, { recursive: true, force: true }).catch(() => {});
			return err({
				kind: "transaction_aborted",
				reason: "apply_batch_failed",
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			});
		}
	}

	return { metadata, data, observations, on_event, apply_batch };
}

/**
 * Clean up stale transaction staging directories left behind by a previous
 * crash mid-commit.
 * @category Backends
 * @group Storage Backends
 *
 * Stage-and-rename `apply_batch` writes everything to `<root>/.tx-<id>/`
 * before issuing renames. If the process dies between renames, the staging
 * dir is left on disk. This helper scans `<root>` for `.tx-*` directories
 * and removes them. We do not attempt to roll forward — leftover staging
 * dirs represent aborted transactions.
 *
 * Call once at startup before the first `create_file_backend()` against a
 * directory that may have been left in a half-state. **Do not** invoke
 * concurrently with another process that's actively writing the same
 * directory — there's no locking, and you may race a live transaction.
 *
 * @param root_dir - The same `base_path` passed to `create_file_backend`
 * @returns `{ recovered, aborted }` — `aborted` is the number of staging
 *          dirs found, `recovered` is the number successfully removed.
 *
 * @example
 * ```ts
 * await recover('./data/corpus')
 * const backend = create_file_backend({ base_path: './data/corpus' })
 * ```
 */
export async function recover(root_dir: string): Promise<Result<{ recovered: number; aborted: number }, CorpusError>> {
	const entries = await try_catch_async(
		() => readdir(root_dir, { withFileTypes: true }),
		(cause): CorpusError => ({ kind: "storage_error", cause: to_error(cause), operation: "recover" }),
	);
	if (!entries.ok) return entries;

	const stale = entries.value.filter((e) => e.isDirectory() && e.name.startsWith(TX_DIR_PREFIX));
	let recovered = 0;
	const failures: Error[] = [];
	for (const entry of stale) {
		const removed = await try_catch_async(
			() => rm(join(root_dir, entry.name), { recursive: true, force: true }),
			to_error,
		);
		if (removed.ok) recovered++;
		else failures.push(removed.error);
	}

	const [first_failure] = failures;
	if (first_failure) {
		return err({
			kind: "storage_error",
			cause: first_failure,
			operation: "recover",
		});
	}

	return ok({ recovered, aborted: stale.length });
}
