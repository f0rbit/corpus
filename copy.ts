/**
 * @module Copy
 * @description Restic-style incremental cross-backend snapshot copy.
 *
 * `copy(source, dest, opts)` clones the snapshots (metadata + data) of one
 * or more stores from a source `Backend` to a destination `Backend`,
 * transferring only what's missing at the destination:
 *
 * - A version is skipped the moment its metadata already exists at `dest`
 *   (a corpus snapshot is immutable, so metadata presence IS "already
 *   copied" — no content comparison needed).
 * - A data blob is skipped when its `data_key` already exists at `dest`,
 *   whether from a prior `copy()` run or because a different version in
 *   this same run already transferred the same content-addressed blob.
 *
 * `SnapshotMeta` is copied verbatim — version, timestamps, content_hash,
 * data_key, parents, and tags are untouched. A clone is a replica, not a
 * re-ingest. One consequence: a custom `data_key_fn` layout lands at the
 * destination with the SOURCE's keys, which is where the file backend's
 * `data_path` sanitisation (`/` → `_`, see `backend/file.ts`) can alias two
 * distinct source keys onto one destination file. Not addressed here — the
 * default `${store_id}/${content_hash}` layout never collides.
 *
 * Workers-safe: this module imports only `./types.js`, `./result.js`, and
 * `./concurrency.js` — no Node built-ins, no backend implementations — so
 * it's reachable from the main barrel without pulling in anything
 * Workers-unsafe.
 *
 * @example
 * ```ts
 * const summary = await copy(remote_backend, file_backend, {
 *   tags: ["published"],
 *   concurrency: 8,
 *   on_progress: (e) => {
 *     if (e.type === "store_done") console.log(`${e.store_id}: +${e.versions_copied}`)
 *   },
 * })
 *
 * if (summary.ok) {
 *   console.log(`copied ${summary.value.bytes_copied} bytes across ${summary.value.stores.length} stores`)
 * }
 * ```
 */

import type { Backend, CorpusError, Result, SnapshotMeta } from "./types.js";
import { ok, err } from "./types.js";
import { parallel_map } from "./concurrency.js";
import { pipe } from "./result.js";

/**
 * Progress events emitted during `copy()` via `CopyOpts.on_progress`. This is
 * the ONLY channel for observing progress — library code carries a full
 * no-console ban.
 *
 * `data_copied` / `data_skipped` fire at most once per distinct `data_key`
 * per `copy()` call, regardless of how many versions reference that key
 * (content-hash dedup — see the module doc).
 *
 * @category Types
 * @group Copy Types
 */
export type CopyProgressEvent =
	| { type: "store_start"; store_id: string }
	| { type: "version_copied"; store_id: string; version: string }
	| { type: "version_skipped"; store_id: string; version: string }
	| { type: "data_copied"; data_key: string; bytes: number }
	| { type: "data_skipped"; data_key: string }
	| { type: "store_done"; store_id: string; versions_copied: number; versions_skipped: number };

/**
 * Options for `copy()`.
 *
 * @category Types
 * @group Copy Types
 */
export type CopyOpts = {
	/** Explicit store ids to copy. If omitted, resolved via `source.metadata.list_stores()`. */
	stores?: string[];
	/** Only copy versions carrying ALL of these tags (same semantics as `ListOpts.tags`). */
	tags?: string[];
	/**
	 * Preview mode. `dest.metadata.get` is still checked (so `versions_copied`
	 * / `versions_skipped` reflect what a real run would do), but no reads or
	 * writes touch `dest.data` and nothing is written to `dest` at all —
	 * `data_objects_copied`, `data_objects_skipped`, and `bytes_copied` stay 0.
	 */
	dry_run?: boolean;
	/** Max concurrent version-level transfers per store. Default 4. */
	concurrency?: number;
	on_progress?: (event: CopyProgressEvent) => void;
};

/**
 * Result of a `copy()` run.
 *
 * @category Types
 * @group Copy Types
 */
export type CopySummary = {
	stores: string[];
	versions_copied: number;
	versions_skipped: number;
	data_objects_copied: number;
	data_objects_skipped: number;
	bytes_copied: number;
	dry_run: boolean;
};

type VersionOutcome = { copied: boolean };

/** Per-call singleflight transfer of one data blob, deduplicated by `data_key`. */
type DataTransferrer = (data_key: string, size_bytes: number) => Promise<Result<void, CorpusError>>;

/** Runs enqueued async ops one at a time, in call order. */
type SerialQueue = <T>(fn: () => Promise<T>) => Promise<T>;

const noop_progress = (_event: CopyProgressEvent): void => {};

/**
 * Builds a FIFO serializer. `dest.metadata.put` is NOT guaranteed atomic
 * under concurrent calls for different versions of the same store — the
 * file backend, for one, does an unsynchronized read-`_meta.json`-modify-
 * write per call (`backend/file.ts`), so two concurrent puts against the
 * same store can both read the same on-disk snapshot and the second write
 * silently drops the first. `copy()` bounds VERSION-level work (data
 * transfer + metadata write) with `parallel_map`, so without this the race
 * is directly reachable — and was caught by this task's own dedup
 * integration test. Serializing only the metadata write (cheap; the data
 * transfer stays fully concurrent up to `opts.concurrency`) sidesteps the
 * hazard for any backend with this shape of read-modify-write, not just the
 * file backend, without touching backend implementations.
 */
function make_serial_queue(): SerialQueue {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const scheduled = tail.then(fn, fn);
		tail = scheduled;
		return scheduled;
	};
}

async function resolve_store_ids(source: Backend, opts: CopyOpts): Promise<Result<string[], CorpusError>> {
	if (opts.stores) return ok(opts.stores);

	if (!source.metadata.list_stores) {
		return err({
			kind: "invalid_config",
			message:
				"copy(): source backend has no metadata.list_stores() — pass opts.stores explicitly (e.g. `--store <id>` on the CLI) to select which stores to copy.",
		});
	}

	const ids: string[] = [];
	for await (const id of source.metadata.list_stores()) ids.push(id);
	return ok(ids);
}

/**
 * Builds a per-`copy()`-call data transferrer. Concurrent calls for the same
 * `data_key` share one in-flight promise (a JS `Map` cache keyed by
 * `data_key`, populated synchronously before the first `await`, so there's no
 * race window between two version tasks checking "is this key already being
 * transferred") — this is what makes the content-hash dedup deterministic
 * under `parallel_map` concurrency: two versions sharing a `data_key` always
 * produce exactly one `data_copied` (or `data_skipped`) event and one
 * physical transfer, never two.
 *
 * `dest.data.exists` is always checked first (this IS the idempotency check —
 * re-running `copy()` against an already-populated dest transfers zero
 * bytes). The stream is piped straight from `source.data.get` into
 * `dest.data.put`; nothing is buffered into memory here.
 */
function make_data_transferrer(
	source: Backend,
	dest: Backend,
	emit: (event: CopyProgressEvent) => void,
): DataTransferrer {
	const in_flight = new Map<string, Promise<Result<void, CorpusError>>>();

	return function transfer(data_key, size_bytes) {
		const cached = in_flight.get(data_key);
		if (cached) return cached;

		const promise = (async (): Promise<Result<void, CorpusError>> => {
			const exists = await dest.data.exists(data_key);
			if (exists) {
				emit({ type: "data_skipped", data_key });
				return ok(undefined);
			}

			return pipe(source.data.get(data_key))
				.flat_map((handle) => dest.data.put(data_key, handle.stream()))
				.tap(() => {
					emit({ type: "data_copied", data_key, bytes: size_bytes });
				})
				.result();
		})();

		in_flight.set(data_key, promise);
		return promise;
	};
}

/**
 * Copy (or skip) one version. Data is always transferred BEFORE metadata is
 * written at `dest` — an interruption between the two calls leaves no
 * metadata pointing at missing data (the reverse order would).
 */
async function copy_version(
	meta: SnapshotMeta,
	dest: Backend,
	dry_run: boolean,
	on_progress: (event: CopyProgressEvent) => void,
	transfer_data: DataTransferrer,
	put_meta_serial: SerialQueue,
): Promise<Result<VersionOutcome, CorpusError>> {
	const existing = await dest.metadata.get(meta.store_id, meta.version);
	if (existing.ok) {
		on_progress({ type: "version_skipped", store_id: meta.store_id, version: meta.version });
		return ok({ copied: false });
	}

	if (dry_run) {
		on_progress({ type: "version_copied", store_id: meta.store_id, version: meta.version });
		return ok({ copied: true });
	}

	return pipe(transfer_data(meta.data_key, meta.size_bytes))
		.flat_map((): Promise<Result<void, CorpusError>> => put_meta_serial(() => dest.metadata.put(meta)))
		.tap(() => {
			on_progress({ type: "version_copied", store_id: meta.store_id, version: meta.version });
		})
		.map((): VersionOutcome => ({ copied: true }))
		.result();
}

/**
 * Copy snapshots from `source` to `dest`, transferring only what's missing
 * at the destination.
 * @category Core
 * @group Copy
 *
 * See the module doc for the full skip/dedup semantics. Store enumeration
 * and per-store version listing are sequential; version-level data+metadata
 * transfer within a store is bounded by `opts.concurrency` (default 4) via
 * `parallel_map`. A version-level error short-circuits the REST of that
 * store (no further versions start) and is returned as the overall `err()`
 * — the `on_progress` callback is the only channel that reports partial
 * progress made before the failure.
 *
 * @param source - Backend to read snapshots from
 * @param dest - Backend to write snapshots to
 * @param opts - Store/tag filters, dry-run, concurrency, progress callback
 * @returns A `CopySummary` on success, or the first `CorpusError` encountered
 *
 * @example
 * ```ts
 * const result = await copy(prod_backend, backup_backend, { concurrency: 8 })
 * if (!result.ok) {
 *   console.error(`clone failed: ${result.error.kind}`)
 * } else {
 *   console.log(`${result.value.versions_copied} versions, ${result.value.bytes_copied} bytes`)
 * }
 * ```
 */
export async function copy(
	source: Backend,
	dest: Backend,
	opts: CopyOpts = {},
): Promise<Result<CopySummary, CorpusError>> {
	const store_ids_result = await resolve_store_ids(source, opts);
	if (!store_ids_result.ok) return store_ids_result;
	const store_ids = store_ids_result.value;

	const dry_run = opts.dry_run ?? false;
	const concurrency = opts.concurrency ?? 4;
	const on_progress = opts.on_progress ?? noop_progress;

	let data_objects_copied = 0;
	let data_objects_skipped = 0;
	let bytes_copied = 0;

	const emit = (event: CopyProgressEvent): void => {
		if (event.type === "data_copied") {
			data_objects_copied++;
			bytes_copied += event.bytes;
		} else if (event.type === "data_skipped") {
			data_objects_skipped++;
		}
		on_progress(event);
	};

	const transfer_data = make_data_transferrer(source, dest, emit);

	let versions_copied = 0;
	let versions_skipped = 0;

	for (const store_id of store_ids) {
		emit({ type: "store_start", store_id });

		const metas: SnapshotMeta[] = [];
		for await (const meta of source.metadata.list(store_id, { tags: opts.tags })) metas.push(meta);

		let store_versions_copied = 0;
		let store_versions_skipped = 0;
		let aborted: CorpusError | undefined;
		const put_meta_serial = make_serial_queue();

		await parallel_map(
			metas,
			async (meta) => {
				if (aborted) return;
				const result = await copy_version(meta, dest, dry_run, emit, transfer_data, put_meta_serial);
				if (!result.ok) {
					aborted = result.error;
					return;
				}
				if (result.value.copied) store_versions_copied++;
				else store_versions_skipped++;
			},
			concurrency,
		);

		if (aborted) return err(aborted);

		versions_copied += store_versions_copied;
		versions_skipped += store_versions_skipped;
		emit({
			type: "store_done",
			store_id,
			versions_copied: store_versions_copied,
			versions_skipped: store_versions_skipped,
		});
	}

	return ok({
		stores: store_ids,
		versions_copied,
		versions_skipped,
		data_objects_copied,
		data_objects_skipped,
		bytes_copied,
		dry_run,
	});
}
