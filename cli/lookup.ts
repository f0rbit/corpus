import type { Backend, CorpusError, Result, SnapshotMeta } from "../types.js";
import { err, ok } from "../types.js";
import { collect_list } from "./backend-errors.js";

export const store_not_found = (store_id: string): CorpusError => ({
	kind: "not_found",
	store_id,
	version: "",
	message: "no versions",
});

// A store exists iff it has at least one version; distinguishes "no such
// store" from "this version of an existing store is missing".
async function store_has_versions(backend: Backend, store_id: string): Promise<Result<boolean, CorpusError>> {
	const latest = await backend.metadata.get_latest(store_id);
	if (latest.ok) return ok(true);
	return latest.error.kind === "not_found" ? ok(false) : latest;
}

export async function ensure_store(backend: Backend, store_id: string): Promise<Result<void, CorpusError>> {
	const exists = await store_has_versions(backend, store_id);
	if (!exists.ok) return exists;
	return exists.value ? ok(undefined) : err(store_not_found(store_id));
}

// Shared by `show` and `cat`: "latest" resolves via get_latest. A miss on a
// store with no versions at all reports the store, not the version.
export async function resolve_meta(
	backend: Backend,
	store_id: string,
	version: string,
): Promise<Result<SnapshotMeta, CorpusError>> {
	const found =
		version === "latest" ? await backend.metadata.get_latest(store_id) : await backend.metadata.get(store_id, version);
	if (found.ok || found.error.kind !== "not_found") return found;

	const exists = await ensure_store(backend, store_id);
	return exists.ok ? found : exists;
}

// `versions` on an unfiltered-miss: list, then distinguish an empty store
// from a missing one only when the result is empty.
export async function list_versions(
	backend: Backend,
	store_id: string,
	opts: Parameters<Backend["metadata"]["list"]>[1],
): Promise<Result<SnapshotMeta[], CorpusError>> {
	const listed = await collect_list(backend, backend.metadata.list(store_id, opts));
	if (!listed.ok || listed.value.length > 0) return listed;

	const exists = await ensure_store(backend, store_id);
	return exists.ok ? listed : exists;
}
