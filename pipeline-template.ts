/**
 * @module PipelineTemplate
 * @description Store factory for compiled pipeline template snapshots —
 * content-addressed JSON blobs produced by a CLI step that bundles a
 * package's `pipeline.ts` declaration into a serialised
 * `PipelineTemplate` shape. Consumed by devpad's pipeline orchestrator
 * to rehydrate the typed template at run start.
 *
 * Templates are content-addressed and naturally dedup across packages —
 * unlike `version_set_store`, there is no per-package partition. The
 * `data_key` layout is `pipeline-templates/<content_hash>`.
 */

import type { z } from "zod";
import type { Backend, CorpusError, PutOpts, Result, SnapshotMeta, Snapshot, Store } from "./types.js";
import { define_store } from "./types.js";
import { create_store } from "./corpus.js";
import { json_codec } from "./utils.js";

/**
 * Configuration for `pipeline_template_store`.
 *
 * @category Types
 * @group Pipeline Template Types
 */
export type PipelineTemplateStoreOptions = {
	/** Store id. Defaults to `'pipeline-templates'`. */
	id?: string;
	/** Description applied to the underlying `StoreDefinition`. */
	description?: string;
};

/**
 * Public API exposed by a pipeline-template store. Wraps the underlying
 * `Store<T>` with the operations consumers need: put (with content-hash
 * dedup), get by version.
 *
 * The generic `T` is the consumer-defined `PipelineTemplate` shape
 * supplied via a Zod schema — corpus never inspects the contents beyond
 * codec round-tripping.
 *
 * @category Types
 * @group Pipeline Template Types
 */
export type PipelineTemplateStore<T> = {
	/** Underlying corpus `Store<T>` for advanced reads. */
	readonly store: Store<T>;
	/**
	 * Store a template snapshot. Content-hash dedup means identical
	 * templates share a single data blob (the corpus dedup) but produce
	 * a fresh `SnapshotMeta` with its own version + tags.
	 */
	put: (template: T, opts?: PutOpts) => Promise<Result<SnapshotMeta, CorpusError>>;
	/**
	 * Fetch a template snapshot by its corpus `version`. Returns the
	 * decoded `T` body along with the snapshot meta.
	 */
	get: (version: string) => Promise<Result<Snapshot<T>, CorpusError>>;
};

/**
 * Create a `pipeline-templates` store on the supplied backend.
 *
 * Wraps `define_store` + `create_store` with a `json_codec` over the
 * consumer-supplied Zod schema, and a `data_key_fn` that lays blobs out
 * under `pipeline-templates/<content_hash>`. The store_id
 * (`pipeline-templates` by default) is shared across all packages —
 * templates are content-addressed and naturally dedup, so there is no
 * per-package partition.
 *
 * @category Builders
 * @group Pipeline Template Types
 *
 * @example
 * ```ts
 * import { create_memory_backend, pipeline_template_store } from '@f0rbit/corpus'
 * import { z } from 'zod'
 *
 * const PipelineTemplateSchema = z.object({
 *   rollout: z.object({ type: z.literal('atomic') }),
 *   gates: z.record(z.unknown()),
 *   pre_deploy_checks: z.array(z.unknown()),
 *   post_deploy_checks: z.array(z.unknown()),
 * })
 *
 * type PipelineTemplate = z.infer<typeof PipelineTemplateSchema>
 *
 * const backend = create_memory_backend()
 * const templates = pipeline_template_store<PipelineTemplate>(
 *   backend,
 *   PipelineTemplateSchema,
 * )
 *
 * const put = await templates.put({
 *   rollout: { type: 'atomic' },
 *   gates: {},
 *   pre_deploy_checks: [],
 *   post_deploy_checks: [],
 * })
 * ```
 */
export function pipeline_template_store<T>(
	backend: Backend,
	schema: z.ZodType<T>,
	opts?: PipelineTemplateStoreOptions,
): PipelineTemplateStore<T> {
	const id = opts?.id ?? "pipeline-templates";

	const definition = define_store(id, json_codec(schema), {
		description: opts?.description ?? "Compiled pipeline template snapshots (content-addressed)",
		data_key_fn: (ctx) => `${id}/${ctx.content_hash}`,
	});

	const store = create_store<T>(backend, definition);

	return {
		store,
		put: (template, put_opts) => store.put(template, put_opts),
		get: (version) => store.get(version),
	};
}
