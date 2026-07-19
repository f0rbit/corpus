import type { SnapshotMeta } from "../types.js";

// Stable JSON-shape sibling of `SnapshotMeta` — Dates become ISO-8601 strings.
// Single source of truth for the "meta" shape embedded in `versions --json`
// and `show --json` (plan task 5.1's documented --json contract).
export type JsonSnapshotMeta = {
	store_id: string;
	version: string;
	parents: SnapshotMeta["parents"];
	created_at: string;
	invoked_at?: string;
	content_hash: string;
	content_type: string;
	size_bytes: number;
	data_key: string;
	tags?: string[];
};

export function serialize_meta(meta: SnapshotMeta): JsonSnapshotMeta {
	return {
		store_id: meta.store_id,
		version: meta.version,
		parents: meta.parents,
		created_at: meta.created_at.toISOString(),
		...(meta.invoked_at ? { invoked_at: meta.invoked_at.toISOString() } : {}),
		content_hash: meta.content_hash,
		content_type: meta.content_type,
		size_bytes: meta.size_bytes,
		data_key: meta.data_key,
		...(meta.tags ? { tags: meta.tags } : {}),
	};
}
