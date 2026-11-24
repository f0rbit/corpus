import type { MutationManifest } from "./types.js";

const utils = "observations/utils.ts";

export const manifest = {
	cluster: "observation-utils",
	old_tests: ["tests/unit/observation-utils.test.ts"],
	new_tests: ["tests/property/observation-utils.test.ts"],
	mutations: [
		{
			id: "observation-utils/pointer-to-key-drops-span",
			file: utils,
			find: "if (pointer.span) key += `:${String(pointer.span.start)}-${String(pointer.span.end)}`;",
			replace: "void pointer.span;",
			guards: "pointer_to_key serialises the span",
		},
		{
			id: "observation-utils/key-to-pointer-first-path-segment",
			file: utils,
			find: 'pointer.path = rest.join(":");',
			replace: 'pointer.path = rest.join(":").split(":")[0] ?? "";',
			guards: "key_to_pointer keeps colon-containing paths whole",
		},
		{
			id: "observation-utils/resolve-path-ok-through-null",
			file: utils,
			find: "if (current === null || current === undefined) {",
			replace:
				"if (current === null || current === undefined) {\n\t\t\treturn ok(current as T);\n\t\t}\n\t\tif (false as boolean) {",
			guards: "resolve_path errors when traversing null/undefined",
		},
		{
			id: "observation-utils/resolve-path-index-off-by-one",
			file: utils,
			find: "parseInt(segment, 10) : segment;",
			replace: "parseInt(segment, 10) + 1 : segment;",
			guards: "resolve_path array indices address the right element",
		},
		{
			id: "observation-utils/apply-span-end-inclusive-length",
			file: utils,
			find: "span.end > value.length",
			replace: "span.end >= value.length",
			guards: "apply_span accepts end === length",
		},
		{
			id: "observation-utils/apply-span-drops-start-gt-end",
			file: utils,
			find: " || span.start > span.end",
			replace: "",
			guards: "apply_span rejects start > end",
		},
		{
			id: "observation-utils/pointers-equal-ignores-span-start",
			file: utils,
			find: "if (a.span?.start !== b.span?.start) return false;",
			replace: "void 0;",
			guards: "pointers_equal compares span.start",
		},
		{
			id: "observation-utils/pointer-to-snapshot-keeps-path",
			file: utils,
			find: "return { store_id: pointer.store_id, version: pointer.version };",
			replace: "return { ...pointer };",
			guards: "pointer_to_snapshot strips path and span",
		},
	],
} satisfies MutationManifest;
