import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, ok, type Result } from "../types.js";
import { type Coverage, type FileCoverage, parse_lcov } from "./lib/lcov.js";
import { create_worktree, remove_worktree, run } from "./lib/worktree.js";

const repo_root = resolve(import.meta.dirname, "..");
const test_timeout_ms = 10 * 60_000;

const measure = async (root: string): Promise<Result<Coverage, string>> => {
	const dir = await mkdtemp(join(tmpdir(), "corpus-cov-"));
	const out = await run(["bun", "test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`], {
		cwd: root,
		timeout_ms: test_timeout_ms,
	});
	const lcov_file = Bun.file(join(dir, "lcov.info"));
	const lcov = (await lcov_file.exists()) ? await lcov_file.text() : undefined;
	await rm(dir, { recursive: true, force: true });
	const summary = `${out.stdout}\n${out.stderr}`;
	if (out.timed_out) return err(`tests timed out in ${root}`);
	if (lcov === undefined) return err(`no lcov output from ${root}: ${summary.slice(-500)}`);
	if (!/^\s*0 fail\b/m.test(summary)) return err(`tests failing in ${root}:\n${summary.slice(-1500)}`);
	return ok(parse_lcov(root, lcov));
};

const ranges = (lines: readonly number[]): string =>
	lines
		.toSorted((a, b) => a - b)
		.reduce<number[][]>((acc, n) => {
			const last = acc.at(-1);
			if (last !== undefined && last[1] === n - 1) last[1] = n;
			else acc.push([n, n]);
			return acc;
		}, [])
		.map(([from, to]) => (from === to ? String(from) : `${String(from)}-${String(to)}`))
		.join(", ");

type FileDiff = { path: string; lost: number[]; gained: number[]; fnh_delta: number; side: "both" | "base" | "head" };

const diff_file = (path: string, base: FileCoverage | undefined, head: FileCoverage | undefined): FileDiff => ({
	path,
	lost: [...(base?.lines ?? [])].filter((n) => !head?.lines.has(n)),
	gained: [...(head?.lines ?? [])].filter((n) => !base?.lines.has(n)),
	fnh_delta: (head?.fnh ?? 0) - (base?.fnh ?? 0),
	side: base && head ? "both" : base ? "base" : "head",
});

const diff = (base: Coverage, head: Coverage): FileDiff[] =>
	[...new Set([...base.keys(), ...head.keys()])]
		.toSorted()
		.map((path) => diff_file(path, base.get(path), head.get(path)));

const regressed = (d: FileDiff): boolean => d.lost.length > 0 || d.fnh_delta < 0;
const changed = (d: FileDiff): boolean => regressed(d) || d.gained.length > 0 || d.fnh_delta !== 0 || d.side !== "both";

const describe_file = (d: FileDiff): string =>
	[
		`${regressed(d) ? "FAIL" : "ok  "} ${d.path}${d.side === "both" ? "" : ` (only in ${d.side})`}`,
		d.lost.length > 0 ? `       lost ${String(d.lost.length)} lines: ${ranges(d.lost)}` : "",
		d.gained.length > 0 ? `       gained ${String(d.gained.length)} lines: ${ranges(d.gained)}` : "",
		d.fnh_delta !== 0 ? `       function hits ${d.fnh_delta > 0 ? "+" : ""}${String(d.fnh_delta)}` : "",
	]
		.filter((line) => line !== "")
		.join("\n");

const out = (text: string): void => {
	process.stdout.write(`${text}\n`);
};

const resolve_base = async (args: readonly string[]): Promise<Result<string, string>> => {
	const at = args.indexOf("--base");
	const given = at === -1 ? undefined : args[at + 1];
	if (at !== -1 && given === undefined) return err("--base requires a ref");
	if (given !== undefined) return ok(given);
	const mb = await run(["git", "merge-base", "HEAD", "origin/main"], { cwd: repo_root });
	return mb.code === 0 ? ok(mb.stdout.trim()) : err(`git merge-base HEAD origin/main failed: ${mb.stderr.trim()}`);
};

const compare = async (base_ref: string): Promise<Result<FileDiff[], string>> => {
	const wt = await create_worktree(base_ref);
	if (!wt.ok) return wt;
	const [head, base] = await Promise.all([measure(repo_root), measure(wt.value.dir)]);
	const removed = await remove_worktree(wt.value);
	if (!removed.ok) process.stderr.write(`warning: ${removed.error}\n`);
	if (!head.ok) return head;
	if (!base.ok) return base;
	return ok(diff(base.value, head.value));
};

const main = async (): Promise<number> => {
	const base_ref = await resolve_base(process.argv.slice(2));
	if (!base_ref.ok) {
		process.stderr.write(`coverage:diff: ${base_ref.error}\n`);
		return 2;
	}
	out(`coverage:diff base=${base_ref.value}`);
	const result = await compare(base_ref.value);
	if (!result.ok) {
		process.stderr.write(`coverage:diff: ${result.error}\n`);
		return 2;
	}
	const files = result.value;
	files.filter(changed).forEach((d) => {
		out(describe_file(d));
	});
	const failed = files.filter(regressed);
	out(failed.length === 0 ? "no lost lines" : `${String(failed.length)} file(s) lost coverage`);
	return failed.length === 0 ? 0 : 1;
};

process.exitCode = await main();
