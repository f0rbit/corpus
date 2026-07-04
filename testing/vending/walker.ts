/**
 * @module testing/vending/walker
 * @description Vending-protocol walker: discovers and loads testing registrars
 * declared by a package and its DIRECT dependencies via the
 * `"corpus": { "testing": "./path/to/register.js" }` package.json key.
 *
 * Discovery reads `{cwd}/package.json`, includes the cwd package itself (so a
 * consumer's own registrar auto-loads alongside its dependencies'), then
 * resolves each direct dependency (dependencies + devDependencies +
 * peerDependencies) and follows its `corpus.testing` key when present.
 *
 * **No transitive walk — deliberate.** Only direct deps are inspected. A
 * transitive dependency's arbitraries are an implementation detail of the
 * direct dep that owns it; if the direct dep wants them vended it re-registers
 * them in its own registrar. Walking the full graph would (a) make
 * registration order — and therefore overwrite warnings — dependent on the
 * package manager's hoisting layout, and (b) execute registrar code from
 * packages the consumer never directly chose to trust.
 *
 * The walker NEVER throws: discovery-level problems (unreadable / malformed
 * cwd package.json) surface as `Result.err(DiscoveryError)`; per-registrar
 * import problems surface as `failed` entries from {@link load_registrars}.
 *
 * Resolution strategy: `import.meta.resolve(dep + "/package.json")` first —
 * this handles hoisted / flat / linked installs from wherever corpus itself
 * is installed. Two portability notes: Bun returns a string synchronously
 * while older resolver shims return a Promise (both shapes are handled), and
 * packages whose `exports` map omits `"./package.json"` make the resolver
 * throw — for those (and for fixture trees that aren't real installs) we fall
 * back to `{cwd}/node_modules/{dep}/package.json`.
 */

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { try_catch, try_catch_async } from "../../result.js";
import { err, ok, type Result } from "../../types.js";

/**
 * The name of the package that ships this walker. When the cwd package IS
 * corpus itself (a dev checkout running its own suite from source), the self
 * registrar in package.json points at `./dist/testing/register.js` — a build
 * artifact of the very source that's currently running. Loading it would
 * double-register through a parallel module graph (dist has its own registry
 * instance) and make `bun test` behave differently depending on whether a
 * stale `dist/` exists. The dev checkout registers itself from source
 * explicitly (see `testing/register.ts`), so the walker skips it.
 */
const SELF_PACKAGE_NAME = "@f0rbit/corpus";

/**
 * A discovered registrar: which package vends it, the file-URL of the module
 * to import, and whether it came from the cwd package itself or a dependency.
 */
export type RegistrarSpec = {
	readonly package: string;
	readonly registrar: string;
	readonly origin: "self" | "dependency";
};

/**
 * Discovery-level failures. Only the cwd package.json can fail discovery —
 * dependency manifests that are missing, unreadable, or malformed are skipped
 * (they simply didn't opt into vending); registrar files that fail to import
 * surface later as `failed` entries from {@link load_registrars}.
 */
export type DiscoveryError =
	| { kind: "package_json_unreadable"; path: string; cause: Error }
	| { kind: "package_json_malformed"; path: string; cause: Error }
	| { kind: "package_unresolvable"; package: string; cause: Error }
	| { kind: "no_registrar"; path: string };

const package_manifest = z
	.object({
		name: z.string().optional(),
		dependencies: z.record(z.string()).optional(),
		devDependencies: z.record(z.string()).optional(),
		peerDependencies: z.record(z.string()).optional(),
		corpus: z.object({ testing: z.string().optional() }).passthrough().optional(),
	})
	.passthrough();

type PackageManifest = z.infer<typeof package_manifest>;

type RegistrarModule = { register?: (() => void | Promise<void>) | undefined };

const to_error = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Discover the registrars vended by `{cwd}/package.json` and its direct
 * dependencies. The cwd package's own registrar (when declared) comes first,
 * followed by dependency registrars in declaration order.
 *
 * Self-registrar carve-outs (both silent, both deliberate):
 * - the cwd package is corpus itself → skipped (see {@link SELF_PACKAGE_NAME});
 * - the declared registrar file doesn't exist → skipped. Manifests usually
 *   point at build output (`./dist/...`); a dev checkout running from source
 *   registers itself explicitly, and warning on every test run would be noise.
 *   A DEPENDENCY with a missing registrar file is NOT skipped — installed
 *   artifacts declaring a registrar that isn't there is a packaging bug, so it
 *   surfaces as a `failed` entry from {@link load_registrars}.
 *
 * @example
 * ```ts
 * const discovered = await discover_registrars()
 * if (discovered.ok) {
 *   const outcome = await load_registrars(discovered.value)
 * }
 * ```
 */
export async function discover_registrars(opts?: { cwd?: string }): Promise<Result<RegistrarSpec[], DiscoveryError>> {
	const cwd = resolve(opts?.cwd ?? process.cwd());
	const manifest = await read_manifest(join(cwd, "package.json"));
	if (!manifest.ok) return manifest;

	const specs: RegistrarSpec[] = [];
	const self = await self_spec(manifest.value, cwd);
	if (self) specs.push(self);

	for (const dep of direct_deps(manifest.value)) {
		const spec = await dependency_spec(dep, cwd);
		if (spec) specs.push(spec);
	}
	return ok(specs);
}

/**
 * Dynamic-import each spec and invoke its exported `register()` when present.
 * Modules without a `register` export are assumed to register via import
 * side-effects (an exported `register()` is preferred — it keeps the module
 * import-safe, so consumers can import brand symbols without registering).
 *
 * Per-spec errors (missing file, throwing registrar) are collected into
 * `failed` — one broken registrar never blocks the others. Specs load
 * sequentially so registration order (and any overwrite warnings) stays
 * deterministic: self first, then dependencies in declaration order.
 */
export async function load_registrars(
	specs: readonly RegistrarSpec[],
): Promise<Result<{ loaded: string[]; failed: Array<{ package: string; cause: Error }> }, never>> {
	const loaded: string[] = [];
	const failed: Array<{ package: string; cause: Error }> = [];
	for (const spec of specs) {
		const attempt = await try_catch_async(async () => {
			const mod = (await import(spec.registrar)) as RegistrarModule;
			if (typeof mod.register === "function") await mod.register();
		}, to_error);
		if (attempt.ok) loaded.push(spec.package);
		else failed.push({ package: spec.package, cause: attempt.error });
	}
	return ok({ loaded, failed });
}

/**
 * Load a single package's registrar by name or directory — the explicit
 * escape hatch behind `testing.load_from(...)`. Unlike auto-discovery this
 * applies NO self carve-outs: an explicit call means the caller wants THIS
 * registrar, so a missing file surfaces as a `failed` entry.
 */
export async function load_one(
	target: string,
): Promise<Result<{ loaded: string[]; failed: Array<{ package: string; cause: Error }> }, DiscoveryError>> {
	const dir = await target_dir(target);
	if (!dir.ok) return dir;

	const manifest_path = join(dir.value, "package.json");
	const manifest = await read_manifest(manifest_path);
	if (!manifest.ok) return manifest;

	const rel = manifest.value.corpus?.testing;
	if (!rel) return err({ kind: "no_registrar", path: manifest_path });

	const spec: RegistrarSpec = {
		package: manifest.value.name ?? dir.value,
		registrar: pathToFileURL(resolve(dir.value, rel)).href,
		origin: "self",
	};
	return load_registrars([spec]);
}

async function self_spec(manifest: PackageManifest, dir: string): Promise<RegistrarSpec | null> {
	const rel = manifest.corpus?.testing;
	if (!rel) return null;
	if (manifest.name === SELF_PACKAGE_NAME) return null;
	const abs = resolve(dir, rel);
	const exists = await try_catch_async(() => access(abs), to_error);
	if (!exists.ok) return null;
	return { package: manifest.name ?? dir, registrar: pathToFileURL(abs).href, origin: "self" };
}

async function dependency_spec(dep: string, cwd: string): Promise<RegistrarSpec | null> {
	const manifest_path = await resolve_dep_manifest(dep, cwd);
	if (!manifest_path) return null;
	const manifest = await read_manifest(manifest_path);
	if (!manifest.ok) return null;
	const rel = manifest.value.corpus?.testing;
	if (!rel) return null;
	const abs = resolve(dirname(manifest_path), rel);
	return { package: manifest.value.name ?? dep, registrar: pathToFileURL(abs).href, origin: "dependency" };
}

async function resolve_dep_manifest(dep: string, cwd: string): Promise<string | null> {
	const via_resolver = await try_catch_async(async () => {
		const resolved: string | Promise<string> = import.meta.resolve(`${dep}/package.json`);
		return typeof resolved === "string" ? resolved : await resolved;
	}, to_error);
	if (via_resolver.ok) return to_path(via_resolver.value);

	const fallback = join(cwd, "node_modules", dep, "package.json");
	const exists = await try_catch_async(() => access(fallback), to_error);
	return exists.ok ? fallback : null;
}

async function target_dir(target: string): Promise<Result<string, DiscoveryError>> {
	if (isAbsolute(target) || target.startsWith(".")) return ok(resolve(target));
	const manifest_path = await try_catch_async(async () => {
		const resolved: string | Promise<string> = import.meta.resolve(`${target}/package.json`);
		return typeof resolved === "string" ? resolved : await resolved;
	}, to_error);
	if (!manifest_path.ok) return err({ kind: "package_unresolvable", package: target, cause: manifest_path.error });
	return ok(dirname(to_path(manifest_path.value)));
}

async function read_manifest(path: string): Promise<Result<PackageManifest, DiscoveryError>> {
	const raw = await try_catch_async(() => readFile(path, "utf8"), to_error);
	if (!raw.ok) return err({ kind: "package_json_unreadable", path, cause: raw.error });

	const parsed = try_catch((): unknown => JSON.parse(raw.value), to_error);
	if (!parsed.ok) return err({ kind: "package_json_malformed", path, cause: parsed.error });

	const checked = package_manifest.safeParse(parsed.value);
	if (!checked.success) return err({ kind: "package_json_malformed", path, cause: checked.error });
	return ok(checked.data);
}

function direct_deps(manifest: PackageManifest): string[] {
	return [
		...new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
		]),
	];
}

function to_path(resolved: string): string {
	return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}
