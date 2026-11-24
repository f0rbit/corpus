import type { MutationManifest } from "./types.js";

const lib = "concurrency.ts";
const tests = ["tests/unit/concurrency.test.ts"];

export const manifest = {
	cluster: "concurrency",
	old_tests: tests,
	new_tests: tests,
	mutations: [
		{
			id: "concurrency/semaphore-one-extra-permit",
			file: lib,
			find: "new Semaphore(concurrency)",
			replace: "new Semaphore(concurrency + 1)",
			guards: "parallel_map never runs more than `concurrency` mappers at once",
		},
		{
			id: "concurrency/map-skips-acquire",
			file: lib,
			find: "await semaphore.acquire();",
			replace: "void 0;",
			guards: "every mapper waits for a permit before starting",
		},
		{
			id: "concurrency/map-index-always-zero",
			file: lib,
			find: "return await mapper(item, index);",
			replace: "return await mapper(item, 0);",
			guards: "mapper receives the item's real position",
		},
		{
			id: "concurrency/waiters-lifo",
			file: lib,
			find: "this.waiting.shift()",
			replace: "this.waiting.pop()",
			guards: "waiters are woken in FIFO order",
		},
		{
			id: "concurrency/release-mints-permit-on-handoff",
			file: lib,
			find: "next();",
			replace: "next();\n\t\t\tthis.permits++;",
			guards: "handing a permit to a waiter does not also increment permits",
		},
		{
			id: "concurrency/acquire-boundary-ge",
			file: lib,
			find: "if (this.permits > 0) {",
			replace: "if (this.permits >= 0) {",
			guards: "acquire blocks when zero permits remain",
		},
	],
} satisfies MutationManifest;
