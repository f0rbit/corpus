import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, ok, type Result } from "../../types.js";
import { try_catch_async } from "../../result.js";

export type Worktree = { readonly dir: string; readonly ref: string };
export type RunOutput = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timed_out: boolean;
};

const repo_root = resolve(import.meta.dirname, "../..");

const spawn_failed = (message: string): RunOutput => ({ code: 127, stdout: "", stderr: message, timed_out: false });

export const run = async (
	cmd: readonly string[],
	opts: { cwd: string; timeout_ms?: number; env?: Record<string, string> },
): Promise<RunOutput> => {
	const spawned = await try_catch_async(
		() => {
			const proc = Bun.spawn([...cmd], {
				cwd: opts.cwd,
				env: { ...process.env, ...opts.env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const timer =
				opts.timeout_ms === undefined
					? undefined
					: setTimeout(() => {
							proc.kill("SIGKILL");
						}, opts.timeout_ms);
			return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
				([stdout, stderr, code]) => {
					clearTimeout(timer);
					return { code, stdout, stderr, timed_out: proc.signalCode === "SIGKILL" && timer !== undefined };
				},
			);
		},
		(e) => (e instanceof Error ? e.message : String(e)),
	);
	return spawned.ok ? spawned.value : spawn_failed(spawned.error);
};

const git = (args: readonly string[], cwd: string) => run(["git", ...args], { cwd });

const failure = (what: string, out: RunOutput): string => `${what}: ${(out.stderr || out.stdout).trim()}`;

const read_lock = (root: string): Promise<string> => {
	const file = Bun.file(join(root, "bun.lock"));
	return file.exists().then((exists) => (exists ? file.text() : ""));
};

export const remove_worktree = async (wt: Worktree): Promise<Result<void, string>> => {
	await rm(join(wt.dir, "node_modules"), { force: true });
	const removed = await git(["worktree", "remove", "--force", wt.dir], repo_root);
	await rm(wt.dir, { recursive: true, force: true });
	await git(["worktree", "prune"], repo_root);
	return removed.code === 0 ? ok(undefined) : err(failure(`git worktree remove ${wt.dir}`, removed));
};

const prepare = async (wt: Worktree): Promise<Result<Worktree, string>> => {
	const [main_lock, wt_lock] = await Promise.all([read_lock(repo_root), read_lock(wt.dir)]);
	if (main_lock !== wt_lock) return err(`bun.lock at ${wt.ref} differs from the main checkout`);
	const linked = await try_catch_async(
		() => symlink(join(repo_root, "node_modules"), join(wt.dir, "node_modules")),
		(e) => (e instanceof Error ? e.message : String(e)),
	);
	return linked.ok ? ok(wt) : err(`symlink node_modules: ${linked.error}`);
};

export const create_worktree = async (ref: string): Promise<Result<Worktree, string>> => {
	const dir = await mkdtemp(join(tmpdir(), "corpus-wt-"));
	const added = await git(["worktree", "add", "--detach", dir, ref], repo_root);
	if (added.code !== 0) {
		await rm(dir, { recursive: true, force: true });
		return err(failure(`git worktree add ${ref}`, added));
	}
	const wt: Worktree = { dir, ref };
	const prepared = await prepare(wt);
	if (!prepared.ok) {
		const cleaned = await remove_worktree(wt);
		if (!cleaned.ok) return err(`${prepared.error}; cleanup: ${cleaned.error}`);
	}
	return prepared;
};
