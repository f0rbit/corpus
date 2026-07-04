/**
 * @module VersionSet
 * @description Store factory for immutable version-set manifests — the
 * content-addressed tuples of (worker bundle, D1 plan, assets, env manifest,
 * infra plan, grants) consumed by the devpad/pipelines deployment
 * orchestrator.
 */

import { z } from "zod";
import type {
	Backend,
	CorpusError,
	ParentRef,
	PutOpts,
	Result,
	SnapshotMeta,
	Store,
	VersionSetManifest,
	VersionSetRef,
} from "./types.js";
import { ok, err, define_store } from "./types.js";
import { create_store } from "./corpus.js";
import { json_codec } from "./utils.js";

/**
 * Zod schema for `VersionSetManifest`. Source of truth — the static
 * `VersionSetManifest` type in `types.ts` mirrors this shape so that the
 * manifest can be referenced from places that don't pull in `zod`.
 *
 * @category Schemas
 * @group Version Set Types
 */
export const VersionSetManifestSchema = z.object({
	package: z.string(),
	git_sha: z.string().length(40),
	created_at: z.string().datetime(),
	builds: z.object({
		worker: z.object({
			artifact_ref: z.string(),
			size_bytes: z.number().int(),
			compatibility_date: z.string(),
		}),
		assets: z
			.object({
				artifact_ref: z.string().optional(),
				version_affinity: z.enum(["pinned", "none"]).default("pinned"),
			})
			.optional(),
	}),
	migrations: z.object({
		d1_plan_ref: z.string().optional(),
		do_migrations: z
			.array(
				z.object({
					class_name: z.string(),
					tag: z.string(),
					kind: z.enum([
						"new_sqlite_classes",
						"new_classes",
						"renamed_classes",
						"deleted_classes",
						"transferred_classes",
					]),
				}),
			)
			.default([]),
	}),
	env_manifest_ref: z.string(),
	infra_plan_ref: z.string(),
	grants_ref: z.string().optional(),
	template_ref: z.string().optional(),
});

// Compile-time check that the schema's output matches the documented type.
// Zod's `.default()` widens the input but narrows the output to a concrete
// value, so a `satisfies` check against ZodType<VersionSetManifest> rejects
// the mismatched input shape. Using a one-way output assignability check
// gives us the same safety without complaining about the input side.
type _AssertManifestShape =
	z.infer<typeof VersionSetManifestSchema> extends VersionSetManifest
		? VersionSetManifest extends z.infer<typeof VersionSetManifestSchema>
			? true
			: never
		: never;
const _assert_manifest_shape: _AssertManifestShape = true;

/**
 * Configuration for `version_set_store`.
 *
 * @category Types
 * @group Version Set Types
 */
export type VersionSetStoreOptions = {
	/** Store id. Defaults to `'version-sets'`. */
	id?: string;
	/** Description applied to the underlying `StoreDefinition`. */
	description?: string;
};

/**
 * Public API exposed by a version-set store. Wraps the underlying `Store`
 * with operations that respect the version-set semantics: content-hash
 * deduplication on `put`, lineage walking via `parents`, and tag-only
 * promotion to environments.
 *
 * @category Types
 * @group Version Set Types
 */
export type VersionSetStore = {
	/** Underlying corpus `Store<VersionSetManifest>` for advanced reads. */
	readonly store: Store<VersionSetManifest>;
	/**
	 * Store a manifest. Content-hash dedup means identical manifests share a
	 * single data blob (the corpus dedup) but produce a fresh `SnapshotMeta`
	 * with its own version + tags.
	 */
	put: (manifest: VersionSetManifest, opts?: PutOpts) => Promise<Result<SnapshotMeta, CorpusError>>;
	/**
	 * Walk the `parents` chain starting at `version` and yield a `VersionSetRef`
	 * for each ancestor (oldest last). The starting version itself is included
	 * as the first element of the returned array.
	 *
	 * Only parents pointing back at this same store are followed — cross-store
	 * parents (e.g. linking a manifest to its upstream worker-bundle snapshot)
	 * are ignored for lineage.
	 */
	lineage: (version: string) => Promise<Result<VersionSetRef[], CorpusError>>;
	/**
	 * Create a new snapshot referencing the same manifest content as
	 * `from_version` but with new tags (e.g. `production:onebox`). The new
	 * snapshot lists `from_version` as a parent so `lineage()` walks back to
	 * the originating put.
	 *
	 * Dedup means no fresh data write happens — only metadata.
	 */
	promote: (from_version: string, to_tags: string[]) => Promise<Result<SnapshotMeta, CorpusError>>;
};

/**
 * Create a `version-set` store on the supplied backend.
 *
 * Wraps `define_store` + `create_store` with the `json_codec` for the
 * manifest plus a `data_key_fn` that partitions blobs under
 * `<package>/<content_hash>`. The store_id (`version-sets` by default) is
 * shared across all packages — partitioning is purely a storage-layout
 * concern, not a logical one.
 *
 * @category Builders
 * @group Version Set Types
 *
 * @example
 * ```ts
 * import { create_memory_backend, version_set_store } from '@f0rbit/corpus'
 *
 * const backend = create_memory_backend()
 * const version_sets = version_set_store(backend)
 *
 * const put = await version_sets.put({
 *   package: 'anthropic-search',
 *   git_sha: '0123456789abcdef0123456789abcdef01234567',
 *   created_at: new Date().toISOString(),
 *   builds: {
 *     worker: {
 *       artifact_ref: 'worker-bundles/abc',
 *       size_bytes: 12345,
 *       compatibility_date: '2025-05-01',
 *     },
 *   },
 *   migrations: { do_migrations: [] },
 *   env_manifest_ref: 'env-manifests/abc',
 *   infra_plan_ref: 'infra-plans/abc',
 * })
 * ```
 *
 * @example
 * ```ts
 * // promote a built version to an environment via tags
 * const promoted = await version_sets.promote(put.value.version, [
 *   'env:production',
 *   'shape:onebox',
 * ])
 *
 * // walk lineage back to the originating put
 * const chain = await version_sets.lineage(promoted.value.version)
 * // chain.value === [promoted, put] as VersionSetRef[]
 * ```
 */
export function version_set_store(backend: Backend, opts?: VersionSetStoreOptions): VersionSetStore {
	const id = opts?.id ?? "version-sets";

	const definition = define_store(id, json_codec(VersionSetManifestSchema), {
		description: opts?.description ?? "Immutable deployment version-set manifests",
		data_key_fn: (ctx) => {
			// Partition data blobs by package so a single backend can host many
			// packages without their content hashes colliding on the same prefix.
			// The package is recovered from the manifest by encoding it into the
			// version tag set with the `pkg:` prefix on every put / promote.
			const pkg = ctx.tags?.find((t) => t.startsWith("pkg:"))?.slice(4) ?? "unknown";
			return `${id}/${pkg}/${ctx.content_hash}`;
		},
	});

	const store = create_store<VersionSetManifest>(backend, definition);

	function pkg_tag(manifest: VersionSetManifest): string {
		return `pkg:${manifest.package}`;
	}

	function merge_pkg_tag(pkg: string, tags?: string[]): string[] {
		const tag = `pkg:${pkg}`;
		if (!tags || tags.length === 0) return [tag];
		return tags.includes(tag) ? tags : [tag, ...tags];
	}

	async function put_impl(
		manifest: VersionSetManifest,
		put_opts?: PutOpts,
	): Promise<Result<SnapshotMeta, CorpusError>> {
		return store.put(manifest, {
			...put_opts,
			tags: merge_pkg_tag(manifest.package, put_opts?.tags),
		});
	}

	function self_parent(meta: SnapshotMeta): ParentRef | undefined {
		return meta.parents.find((p) => p.store_id === id);
	}

	function ref_from_meta(meta: SnapshotMeta): VersionSetRef {
		const pkg = meta.tags?.find((t) => t.startsWith("pkg:"))?.slice(4) ?? "unknown";
		return { package: pkg, version: meta.version, content_hash: meta.content_hash };
	}

	async function lineage_impl(version: string): Promise<Result<VersionSetRef[], CorpusError>> {
		const chain: VersionSetRef[] = [];
		let cursor: string | undefined = version;
		const seen = new Set<string>();

		while (cursor) {
			if (seen.has(cursor)) break;
			seen.add(cursor);

			const meta_result = await store.get_meta(cursor);
			if (!meta_result.ok) return meta_result;

			chain.push(ref_from_meta(meta_result.value));
			cursor = self_parent(meta_result.value)?.version;
		}

		return ok(chain);
	}

	async function promote_impl(from_version: string, to_tags: string[]): Promise<Result<SnapshotMeta, CorpusError>> {
		const source_result = await store.get(from_version);
		if (!source_result.ok) return source_result;

		const source = source_result.value;
		if (source.data.package !== source.meta.tags?.find((t) => t.startsWith("pkg:"))?.slice(4)) {
			// Defensive: the pkg tag tracks the manifest.package field. If they
			// ever diverge the data_key_fn's partition would be wrong.
			return err({
				kind: "validation_error",
				cause: new Error("package/pkg-tag mismatch on source snapshot"),
				message: `source snapshot ${from_version} has mismatched package/pkg-tag`,
			});
		}

		return store.put(source.data, {
			tags: merge_pkg_tag(source.data.package, to_tags),
			parents: [{ store_id: id, version: from_version, role: "promoted_from" }],
		});
	}

	return {
		store,
		put: put_impl,
		lineage: lineage_impl,
		promote: promote_impl,
	};
}
