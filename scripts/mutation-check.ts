import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { try_catch, try_catch_async } from "../result.js";
import { err, ok, type Result } from "../types.js";
import type { MutationManifest } from "../tests/mutations/types.js";
import { create_worktree, remove_worktree, run, type Worktree } from "./lib/worktree.js";

const repo_root = resolve(import.meta.dirname, "..");
const mutant_timeout_ms = 60_000;

const manifest_schema = z.object({
	cluster: z.string().min(1),
	old_tests: z.array(z.string().min(1)).min(1),
	new_tests: z.array(z.string().min(1)).min(1),
	mutations: z
		.array(
			z.object({
				id: z.string().min(1),
				file: z.string().min(1),
				find: z.string().min(1),
				replace: z.string(),
				guards: z.string(),
			}),
		)
		.min(1),
});

type Side = { readonly name: "old" | "new"; readonly wt: Worktree; readonly tests: readonly string[] };
type Row = { readonly id: string; readonly old: boolean; readonly new: boolean };

const to_message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const write = (text: string): void => {
	process.stdout.write(`${text}\n`);
};
const verdict = (killed: boolean): string => (killed ? "KILLED" : "survived");
const count_occurrences = (text: string, find: string): number => text.split(find).length - 1;

const read_text = async (path: string): Promise<string> => {
	const file = Bun.file(path);
	return (await file.exists()) ? file.text() : "";
};

const sequence = <T, R>(items: readonly T[], f: (item: T) => Promise<R>): Promise<R[]> =>
	items.reduce<Promise<R[]>>(async (acc, item) => [...(await acc), await f(item)], Promise.resolve([]));

const parse_args = (argv: readonly string[]): Result<{ manifest: string; base: string }, string> => {
	const parsed = try_catch(
		() => parseArgs({ args: [...argv], options: { base: { type: "string" } }, allowPositionals: true }),
		to_message,
	);
	if (!parsed.ok) return parsed;
	const manifest = parsed.value.positionals[0];
	if (manifest === undefined) return err("usage: bun scripts/mutation-check.ts <manifest> [--base HEAD]");
	return ok({ manifest: resolve(manifest), base: parsed.value.values.base ?? "HEAD" });
};

const load_manifest = async (path: string): Promise<Result<MutationManifest, string>> => {
	const imported = await try_catch_async(() => import(path) as Promise<{ manifest?: unknown }>, to_message);
	if (!imported.ok) return err(`cannot import manifest: ${imported.error}`);
	const parsed = manifest_schema.safeParse(imported.value.manifest);
	return parsed.success ? ok(parsed.data) : err(`invalid manifest: ${parsed.error.message}`);
};

const stale_errors = async (sides: readonly Side[], manifest: MutationManifest): Promise<string[]> => {
	const checks = sides.flatMap((side) =>
		manifest.mutations.map(async (m) => {
			const matches = count_occurrences(await read_text(join(side.wt.dir, m.file)), m.find);
			return matches === 1
				? null
				: `stale manifest: ${m.id} (${m.file}, ${side.name}) find matched ${String(matches)} times`;
		}),
	);
	return (await Promise.all(checks)).filter((e): e is string => e !== null);
};

const run_tests = (side: Side) =>
	run(["bun", "test", ...side.tests.map((t) => `./${t}`)], { cwd: side.wt.dir, timeout_ms: mutant_timeout_ms });

const sanity = async (side: Side): Promise<string | null> => {
	const out = await run_tests(side);
	return out.code === 0
		? null
		: `sanity pass failed on ${side.name} side (exit ${String(out.code)}):\n${out.stdout}\n${out.stderr}`;
};

const attempt = async (side: Side, file: string, find: string, replace: string): Promise<boolean> => {
	const path = join(side.wt.dir, file);
	const original = await Bun.file(path).text();
	await Bun.write(
		path,
		original.replace(find, () => replace),
	);
	const out = await run_tests(side);
	await Bun.write(path, original);
	return out.code !== 0 || out.timed_out;
};

const evaluate = async (sides: readonly [Side, Side], manifest: MutationManifest): Promise<Result<Row[], string>> => {
	const stale = await stale_errors(sides, manifest);
	if (stale.length > 0) return err(stale.join("\n"));

	const failures = (await sequence(sides, sanity)).filter((f): f is string => f !== null);
	if (failures.length > 0) return err(failures.join("\n"));

	const rows = await sequence(manifest.mutations, async (m): Promise<Row> => {
		const [old_side, new_side] = sides;
		const killed_old = await attempt(old_side, m.file, m.find, m.replace);
		const killed_new = await attempt(new_side, m.file, m.find, m.replace);
		write(`${m.id} old:${verdict(killed_old)} new:${verdict(killed_new)}`);
		return { id: m.id, old: killed_old, new: killed_new };
	});
	return ok(rows);
};

const report = (rows: readonly Row[]): number => {
	const regressions = rows.filter((r) => r.old && !r.new);
	const survivors = rows.filter((r) => !r.new);
	write(`\nregressions (old killed, new survived): ${String(regressions.length)}`);
	regressions.forEach((r) => {
		write(`  ${r.id}`);
	});
	write(`survivors (new side): ${String(survivors.length)}`);
	survivors.forEach((r) => {
		write(`  ${r.id}${r.old ? "" : " (also survived on old)"}`);
	});
	return regressions.length > 0 ? 1 : 0;
};

const snapshot_ref = async (): Promise<string> => {
	const stash = await run(["git", "stash", "create"], { cwd: repo_root });
	return stash.stdout.trim() || "HEAD";
};

const untracked_files = async (): Promise<string[]> => {
	const out = await run(["git", "ls-files", "--others", "--exclude-standard"], { cwd: repo_root });
	return out.stdout.split("\n").filter((l) => l.length > 0);
};

const main = async (argv: readonly string[]): Promise<number> => {
	const args = parse_args(argv);
	if (!args.ok) {
		write(args.error);
		return 2;
	}

	const untracked = await untracked_files();
	if (untracked.length > 0) {
		write(`untracked files present, stage first (git add -A):\n${untracked.map((f) => `  ${f}`).join("\n")}`);
		return 2;
	}

	const manifest = await load_manifest(args.value.manifest);
	if (!manifest.ok) {
		write(manifest.error);
		return 2;
	}

	const base_wt = await create_worktree(args.value.base);
	if (!base_wt.ok) {
		write(base_wt.error);
		return 2;
	}
	const new_wt = await create_worktree(await snapshot_ref());
	if (!new_wt.ok) {
		const cleaned = await remove_worktree(base_wt.value);
		if (!cleaned.ok) write(`warning: ${cleaned.error}`);
		write(new_wt.error);
		return 2;
	}

	const sides: readonly [Side, Side] = [
		{ name: "old", wt: base_wt.value, tests: manifest.value.old_tests },
		{ name: "new", wt: new_wt.value, tests: manifest.value.new_tests },
	];
	const evaluated = await try_catch_async(() => evaluate(sides, manifest.value), to_message);
	const removals = await Promise.all([remove_worktree(base_wt.value), remove_worktree(new_wt.value)]);
	removals.forEach((r) => {
		if (!r.ok) write(`warning: ${r.error}`);
	});

	if (!evaluated.ok) {
		write(`aborted: ${evaluated.error}`);
		return 2;
	}
	if (!evaluated.value.ok) {
		write(evaluated.value.error);
		return 2;
	}
	write(`cluster: ${manifest.value.cluster}`);
	return report(evaluated.value.value);
};

process.exitCode = await main(Bun.argv.slice(2));
