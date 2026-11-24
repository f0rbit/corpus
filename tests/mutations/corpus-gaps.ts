import type { MutationManifest } from "./types.js";

const corpus = "corpus.ts";
const compensation = "tests/integration/transaction-compensation.test.ts";
const pointers = "tests/integration/pointers.test.ts";

export const manifest = {
	cluster: "corpus-gaps",
	old_tests: [
		"tests/integration/backend-contract.test.ts",
		"tests/integration/memory-backend.test.ts",
		"tests/integration/observations-transactions.test.ts",
		"tests/integration/put-if-changed.test.ts",
	],
	new_tests: [
		"tests/integration/backend-contract.test.ts",
		"tests/integration/memory-backend.test.ts",
		"tests/integration/observations-transactions.test.ts",
		"tests/integration/put-if-changed.test.ts",
		compensation,
		pointers,
	],
	mutations: [
		{
			id: "corpus-gaps/compensate-meta-put-skips-delete",
			file: corpus,
			find: 'case "meta_put":\n\t\t\treturn backend.metadata.delete(op.meta.store_id, op.meta.version);',
			replace: 'case "meta_put":\n\t\t\treturn ok(undefined);',
			guards: "a failed sequential commit deletes the metadata it already wrote",
		},
		{
			id: "corpus-gaps/meta-delete-not-flagged-non-undoable",
			file: corpus,
			find: 'if (applied_op.type === "meta_delete" || applied_op.type === "observation_delete") {\n\t\t\t\tcompensation_failed = true;\n\t\t\t\tcontinue;',
			replace:
				'if (applied_op.type === "meta_delete" || applied_op.type === "observation_delete") {\n\t\t\t\tcontinue;',
			guards: "an applied meta_delete can't be undone, so the failure is partial_commit, not an abort",
		},
		{
			id: "corpus-gaps/partial-commit-ops-failed-off-by-one",
			file: corpus,
			find: "ops_failed: ops.length - applied.length,",
			replace: "ops_failed: ops.length - applied.length + 1,",
			guards: "partial_commit reports exactly the ops that did not apply",
		},
		{
			id: "corpus-gaps/resolve-pointer-skips-span",
			file: corpus,
			find: "const span_result = apply_span(value, pointer.span);",
			replace: "const span_result = ok(value);",
			guards: "resolve_pointer slices string values by span and surfaces out-of-range spans",
		},
		{
			id: "corpus-gaps/resolve-pointer-ignores-path",
			file: corpus,
			find: "if (pointer.path) {",
			replace: "if (pointer.path && false) {",
			guards: "resolve_pointer resolves pointer.path against the stored value",
		},
		{
			id: "corpus-gaps/is-superseded-always-false",
			file: corpus,
			find: "return observations_client.is_stale(pointer);",
			replace: "return false;",
			guards: "is_superseded delegates to the observations client's staleness check",
		},
		{
			id: "corpus-gaps/tx-get-latest-ignores-tombstones",
			file: corpus,
			find: "if (!tombstoned_meta.has(meta_key(store_id, m.version))) return ok(m);",
			replace: "return ok(m);",
			guards: "tx.get_latest skips versions deleted earlier in the same transaction",
		},
		{
			id: "corpus-gaps/tx-put-accepts-unregistered-store",
			file: corpus,
			find: "const def = definitions_by_id[store.id];",
			replace: "const def = definitions_by_id[store.id] ?? { id: store.id, codec: store.codec };",
			guards: "tx.put rejects a store that isn't registered on the corpus",
		},
		{
			id: "corpus-gaps/put-encode-error-not-emitted",
			file: corpus,
			find: 'if (!bytes.ok) {\n\t\t\t\temit({ type: "error", error: bytes.error });',
			replace: "if (!bytes.ok) {\n\t\t\t\tvoid bytes;",
			guards: "store.put emits an error event when the codec's encode fails",
		},
	],
} satisfies MutationManifest;
