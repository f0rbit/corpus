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
			find: `			const result = await try_catch_async(
				() => file.exists(),
				() => false,
			);
			return result.ok ? result.value : false;`,
			replace: `			const result = await try_catch_async(
				() => file.exists(),
				() => true,
			);
			return result.ok ? result.value : true;`,
			guards: "a failing existence probe reports false",
		},
		{
			id: "remote-errors/r2-get-handle-on-probe-error",
			file: r2,
			find: "if (!exists_result.ok || !exists_result.value) {",
			replace: "if (exists_result.ok && !exists_result.value) {",
			guards: "get returns null when the existence probe errors",
		},
	],
} satisfies MutationManifest;
