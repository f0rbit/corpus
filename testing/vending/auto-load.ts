/**
 * @module testing/vending/auto-load
 * @description At-most-once auto-loading of vended registrars, triggered by
 * the registry's async accessors (`lookup` / `lookup_failure`).
 *
 * The first accessor call kicks off one walk (see `./walker.js`); concurrent
 * callers share the same in-flight promise, and later callers see the settled
 * one. `__reset_registry_for_tests()` clears the promise alongside the
 * registry maps, so the next accessor call re-walks against fresh state.
 *
 * Auto-load never throws and never fails a lookup: discovery errors and
 * per-registrar load failures degrade to a `console.warn` with a pointer at
 * the explicit escape hatch ({@link load_from}). A broken registrar in one
 * dependency must not take down every property test in the consumer's suite.
 *
 * The walker is imported dynamically so this module (which sits on the
 * registry's static import path, and therefore on `@f0rbit/corpus`'s main
 * barrel) never pulls `node:fs` / `node:path` into graphs that run on
 * workerd. Synchronous registry paths — `arb(schema)` and `compose` — do NOT
 * touch this module and never trigger auto-load.
 */

import type { Result } from "../../types.js";
import type { DiscoveryError } from "./walker.js";

let auto_load_promise: Promise<void> | null = null;
let auto_load_cwd: string | null = null;

/**
 * Ensure vended registrars have been discovered and loaded. Idempotent per
 * registry state: the walk runs at most once until the registry is reset, and
 * concurrent callers share the same promise.
 *
 * Called by the registry's `lookup` / `lookup_failure` — consumers normally
 * never call this directly.
 */
export function ensure_loaded(): Promise<void> {
	auto_load_promise ??= run_auto_load();
	return auto_load_promise;
}

async function run_auto_load(): Promise<void> {
	const walker = await import("./walker.js");
	const discovered = await walker.discover_registrars(auto_load_cwd === null ? undefined : { cwd: auto_load_cwd });
	if (!discovered.ok) {
		console.warn(
			`[corpus/testing] auto-load: registrar discovery failed (${describe_discovery_error(discovered.error)}). ` +
				`Vended arbitraries are unavailable — fix the manifest or load one explicitly via testing.load_from(<package-or-dir>).`,
		);
		return;
	}
	const outcome = await walker.load_registrars(discovered.value);
	if (!outcome.ok) return;
	for (const failure of outcome.value.failed) {
		console.warn(
			`[corpus/testing] auto-load: registrar for '${failure.package}' failed to load: ${failure.cause.message}. ` +
				`Fix that package's "corpus": { "testing": ... } entry, or load a corrected registrar via testing.load_from(...).`,
		);
	}
}

/**
 * Explicitly load one package's registrar by npm package name or directory
 * path — the escape hatch when auto-discovery can't see the package (not a
 * direct dependency, fixture trees, monorepo siblings) or when a test wants
 * deterministic control over which registrar populates the registry.
 *
 * Additive: does not mark auto-load as done, so a later `lookup` still walks
 * the dependency graph as usual.
 *
 * @example
 * ```ts
 * import { testing } from "@f0rbit/corpus"
 *
 * const loaded = await testing.load_from("/path/to/fixture-package")
 * if (loaded.ok) {
 *   const arb = await testing.lookup(AUTH_TOKEN_BRAND)
 * }
 * ```
 */
export async function load_from(
	package_name_or_dir: string,
): Promise<Result<{ loaded: string[]; failed: Array<{ package: string; cause: Error }> }, DiscoveryError>> {
	const walker = await import("./walker.js");
	return walker.load_one(package_name_or_dir);
}

/**
 * Clear the cached auto-load promise so the next registry access re-walks.
 * Invoked by `__reset_registry_for_tests()` — not part of the public surface.
 */
export function __reset_auto_load_for_tests(): void {
	auto_load_promise = null;
}

/**
 * Override the directory auto-load walks from (defaults to `process.cwd()`).
 * Test-only seam — lets the suite point auto-load at a fixture tree instead
 * of the real repository. Pass `null` to restore the default.
 */
export function __set_auto_load_cwd_for_tests(cwd: string | null): void {
	auto_load_cwd = cwd;
}

function describe_discovery_error(error: DiscoveryError): string {
	switch (error.kind) {
		case "package_json_unreadable":
			return `could not read ${error.path}: ${error.cause.message}`;
		case "package_json_malformed":
			return `could not parse ${error.path}: ${error.cause.message}`;
		case "package_unresolvable":
			return `could not resolve package '${error.package}': ${error.cause.message}`;
		case "no_registrar":
			return `${error.path} declares no "corpus": { "testing": ... } entry`;
	}
}
