import type { MutationManifest } from "./types.js";

const lib = "scripts/lib/content-key.ts";
const tests = ["tests/unit/coverage-diff-content.test.ts"];

export const manifest = {
	cluster: "coverage-diff",
	old_tests: tests,
	new_tests: tests,
	mutations: [
		{
			id: "coverage-diff/occurrence-index-always-zero",
			file: lib,
			find: "const k = counts.get(text) ?? 0;",
			replace: "const k = 0;",
			guards: "duplicated text is keyed by its occurrence index",
		},
		{
			id: "coverage-diff/removed-counted-as-lost",
			file: lib,
			find: "return { lost, removed, gained };",
			replace: "return { lost: [...lost, ...removed], removed, gained };",
			guards: "edited lines are reported as removed, not lost",
		},
		{
			id: "coverage-diff/keys-from-untrimmed-lines",
			file: lib,
			find: "const text = raw.trim();",
			replace: "const text = raw;",
			guards: "re-indented lines keep their identity",
		},
		{
			id: "coverage-diff/brace-lines-not-skipped",
			file: lib,
			find: 'text === "" || noise.has(text)',
			replace: 'text === "" || (noise.has(text) && false)',
			guards: "brace-only lines are noise and never reported",
		},
		{
			id: "coverage-diff/lost-ignores-head-text",
			file: lib,
			find: ".filter(([key]) => head_at.has(key))",
			replace: ".filter(() => true)",
			guards: "a loss requires the same text to still exist in head",
		},
	],
} satisfies MutationManifest;
