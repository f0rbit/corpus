import type { MutationManifest } from "./types.js";

const equality = "testing/laws/equality.ts";

export const manifest = {
	cluster: "equality",
	old_tests: ["tests/unit/testing-laws-basic.test.ts"],
	new_tests: ["tests/unit/testing-laws-basic.test.ts"],
	mutations: [
		{
			id: "equality/message-omits-law",
			file: equality,
			find: "`${law}: no equality function provided",
			replace: "`law: no equality function provided",
			guards: "the no-Bun error names the law that needs opts.equals",
		},
		{
			id: "equality/has-bun-ignored",
			file: equality,
			find: "if (has_bun) {",
			replace: "if (true) {",
			guards: "the no-Bun branch is selected by the has_bun seam",
		},
	],
} satisfies MutationManifest;
