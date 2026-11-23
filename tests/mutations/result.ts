import type { MutationManifest } from "./types.js";

const lib = "result.ts";

export const manifest = {
	cluster: "result",
	old_tests: ["tests/unit/result.test.ts"],
	new_tests: ["tests/unit/result.test.ts", "tests/property/result-laws.test.ts"],
	// Not listed (equivalent): `at`'s first bounds guard (`index < 0 || index >= array.length`) is shadowed by the
	// `element === undefined` branch, which returns the identical error, so loosening the guard is unobservable.
	// The `length - 1` mutant below is not equivalent: it rejects the last valid index.
	mutations: [
		{
			id: "result/match-swaps-branches",
			file: lib,
			find: "if (result.ok) return on_ok(result.value);\n\treturn on_err(result.error);",
			replace: "if (result.ok) return on_err(result.value as never);\n\treturn on_ok(result.error as never);",
			guards: "match calls on_ok for ok and on_err for err",
		},
		{
			id: "result/unwrap-or-always-default",
			file: lib,
			find: "result.ok ? result.value : default_value",
			replace: "result.ok ? default_value : default_value",
			guards: "unwrap_or returns the value on ok",
		},
		{
			id: "result/to-fallback-ignores-value",
			file: lib,
			find: "(result.ok ? result.value : fallback)",
			replace: "(result.ok ? fallback : fallback)",
			guards: "to_fallback returns the value on ok",
		},
		{
			id: "result/null-on-negates-predicate",
			file: lib,
			find: "if (predicate(result.error)) return null;",
			replace: "if (!predicate(result.error)) return null;",
			guards: "null_on returns null only when the predicate accepts the error",
		},
		{
			id: "result/fallback-on-swallows-unexpected",
			file: lib,
			find: "if (predicate(result.error)) return fallback;\n\tthrow result.error;",
			replace: "return fallback;",
			guards: "fallback_on rethrows errors the predicate rejects",
		},
		{
			id: "result/try-catch-skips-mapper",
			file: lib,
			find: "return ok(fn());\n\t} catch (e) {\n\t\treturn err(on_error(e));",
			replace: "return ok(fn());\n\t} catch (e) {\n\t\treturn err(e as E);",
			guards: "try_catch maps the thrown value through on_error",
		},
		{
			id: "result/try-catch-async-skips-mapper",
			file: lib,
			find: "return ok(await fn());\n\t} catch (e) {\n\t\treturn err(on_error(e));",
			replace: "return ok(await fn());\n\t} catch (e) {\n\t\treturn err(e as E);",
			guards: "try_catch_async maps the rejection through on_error",
		},
		{
			id: "result/pipe-flat-map-no-short-circuit",
			file: lib,
			find: "if (r.ok) return fn(r.value);\n\t\t\t\treturn err(r.error);",
			replace: "return fn((r as { ok: true; value: T }).value);",
			guards: "pipe.flat_map does not run its function on err",
		},
		{
			id: "result/format-error-stringifies-errors",
			file: lib,
			find: "e instanceof Error ? e.message : String(e)",
			replace: "String(e)",
			guards: "format_error yields Error.message",
		},
		{
			id: "result/merge-deep-recurses-into-arrays",
			file: lib,
			find: "!Array.isArray(value) && ",
			replace: "",
			guards: "merge_deep replaces arrays wholesale",
		},
		{
			id: "result/merge-deep-undefined-overwrites",
			file: lib,
			find: "} else if (value !== undefined) {",
			replace: "} else {",
			guards: "merge_deep ignores undefined overrides",
		},
		{
			id: "result/at-rejects-last-index",
			file: lib,
			find: "index >= array.length)",
			replace: "index >= array.length - 1)",
			guards: "at accepts every index below length",
		},
		{
			id: "result/last-returns-first",
			file: lib,
			find: "ok(array[array.length - 1] as T)",
			replace: "ok(array[0] as T)",
			guards: "last returns the final element",
		},
	],
} satisfies MutationManifest;
