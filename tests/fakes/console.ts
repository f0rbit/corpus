/**
 * In-memory fake for `console.warn`, used to assert on corpus's documented
 * degrade-to-console UX (auto-load discovery failures, duplicate-registration
 * warnings) without reaching for `bun:test`'s `spyOn` — a plain reassignment
 * records calls exactly like `mock_fetch` does for `globalThis.fetch`.
 */
export function fake_console_warn(): { calls: unknown[][]; restore: () => void } {
	const original = console.warn;
	const calls: unknown[][] = [];
	console.warn = (...args: unknown[]) => {
		calls.push(args);
	};
	return {
		calls,
		restore: () => {
			console.warn = original;
		},
	};
}
