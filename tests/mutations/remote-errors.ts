import type { MutationManifest } from "./types.js";

const d1 = "backend/remote-d1.ts";
const r2 = "backend/remote-r2.ts";
const errors = "tests/integration/remote-errors.test.ts";

export const manifest = {
	cluster: "remote-errors",
	old_tests: ["tests/integration/remote-backend.test.ts", "tests/integration/backend-contract.test.ts"],
	new_tests: ["tests/integration/remote-backend.test.ts", "tests/integration/backend-contract.test.ts", errors],
	mutations: [
		{
			id: "remote-errors/d1-ignores-http-status",
			file: d1,
			find: "if (!response.ok) {",
			replace: "if (false as boolean) {",
			guards: "non-2xx D1 responses are storage errors",
		},
		{
			id: "remote-errors/d1-ignores-success-false",
			file: d1,
			find: "if (!envelope.success || envelope.errors.length > 0) {",
			replace: "if (false as boolean) {",
			guards: "success:false envelopes are SQL errors",
		},
		{
			id: "remote-errors/d1-ignores-empty-result",
			file: d1,
			find: "if (envelope.result.length === 0) {",
			replace: "if (false as boolean) {",
			guards: "an envelope with no result entries is an error",
		},
		{
			id: "remote-errors/d1-statement-failed-inverted",
			file: d1,
			find: "if (!result_obj || !result_obj.success) {",
			replace: "if (!result_obj || result_obj.success) {",
			guards: "a failed statement entry is an error",
		},
		{
			id: "remote-errors/r2-exists-catch-true",
			file: r2,
			find: "return file.exists();",
			replace: "return file.exists().catch(() => true);",
			guards: "a failing existence probe reports false",
		},
		{
			id: "remote-errors/r2-exists-swallows-probe-error",
			file: r2,
			find: "return file.exists();",
			replace: "return file.exists().catch(() => false);",
			guards: "a failing existence probe emits a storage_error event",
		},
		{
			id: "remote-errors/r2-get-probe-error-as-miss",
			file: r2,
			find: "if (!(await file.exists())) return null;",
			replace: "if (!(await file.exists().catch(() => false))) return null;",
			guards: "get is storage_error, not not_found, when the existence probe errors",
		},
	],
} satisfies MutationManifest;
