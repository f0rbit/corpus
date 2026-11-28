import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { try_catch_async } from "../result.js";
import { err, ok, type Result } from "../types.js";
import { run } from "./lib/worktree.js";

const repo_root = resolve(import.meta.dirname, "..");
const devpad_project = "project_48a94a81-b0ef-4bc9-b7f9-c1d08dae78f5";
const devpad_timeout_ms = 20_000;
const marker_cap = 40;

const out = (text: string): void => {
	process.stdout.write(`${text}\n`);
};

// this file is excluded from its own marker scan
const MARKER_RE = /\b(?:TODO|FIXME|HACK|XXX)\b/;

type Ctx = { readonly files: readonly string[]; readonly texts: ReadonlyMap<string, string> };

const tracked_files = async (): Promise<Result<string[], string>> => {
	const res = await run(["git", "ls-files"], { cwd: repo_root });
	if (res.code !== 0) return err(`git ls-files failed: ${(res.stderr || res.stdout).trim()}`);
	return ok(res.stdout.split("\n").filter((p) => p !== ""));
};

const read_texts = async (paths: readonly string[]): Promise<Map<string, string>> => {
	const results = await Promise.all(
		paths.map(
			async (p) =>
				[
					p,
					await try_catch_async(
						() => Bun.file(join(repo_root, p)).text(),
						() => "",
					),
				] as const,
		),
	);
	return new Map(results.flatMap(([p, r]) => (r.ok ? [[p, r.value] as const] : [])));
};

const is_scannable = (p: string): boolean =>
	/\.(?:ts|js|mjs|md|mdx|json|toml|yml|yaml|html|txt)$/.test(p) &&
	!p.startsWith("tests/fixtures/") &&
	!p.startsWith("docs/public/llms") &&
	p !== "scripts/health.ts";

const is_ts_corpus = (p: string): boolean =>
	p.endsWith(".ts") && !p.startsWith("tests/fixtures/") && !p.includes("node_modules/") && !p.startsWith("docs/");

// --- markers ---------------------------------------------------------------

const markers_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const hits = ctx.files
		.filter((p) => ctx.texts.has(p) && is_scannable(p))
		.toSorted()
		.flatMap((p) =>
			(ctx.texts.get(p) ?? "")
				.split("\n")
				.map((text, i) => ({ path: p, line: i + 1, text }))
				.filter((h) => MARKER_RE.test(h.text)),
		);
	const shown = hits.slice(0, marker_cap).map((h) => `  ${h.path}:${String(h.line)}: ${h.text.trim().slice(0, 120)}`);
	const more = hits.length > marker_cap ? [`  ... and ${String(hits.length - marker_cap)} more`] : [];
	return ok([`${String(hits.length)} marker(s) in tracked files`].concat(shown, more).join("\n"));
};

// --- unused export candidates ----------------------------------------------

const LIB_DIRS = ["backend", "observations", "cli", "codecs", "testing"];
const BARRELS = [
	"index.ts",
	"cloudflare.ts",
	"file.ts",
	"remote.ts",
	"types.ts",
	"schema.ts",
	"testing/index.ts",
	"observations/index.ts",
];

const is_lib_source = (p: string): boolean =>
	p.endsWith(".ts") &&
	!p.startsWith("tests/") &&
	!p.startsWith("docs/") &&
	!p.startsWith("scripts/") &&
	p !== "eslint.config.ts" &&
	(LIB_DIRS.some((d) => p.startsWith(`${d}/`)) || !p.includes("/"));

const escape_re = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DECL_RE =
	/^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|type|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const NAMED_EXPORT_RE = /^[ \t]*export\s*\{([^}]*)\}/gm;
const REEXPORT_RE = /export\s+(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;

const exported_names = (source: string): readonly string[] => {
	const names: string[] = [];
	const push = (name: string | undefined): void => {
		if (name !== undefined && name !== "") names.push(name);
	};
	for (const m of source.matchAll(DECL_RE)) push(m.at(1));
	for (const m of source.matchAll(NAMED_EXPORT_RE))
		for (const part of (m.at(1) ?? "").split(","))
			push(
				part
					.trim()
					.split(/\s+as\s+/)
					.pop()
					?.trim(),
			);
	return names;
};

const resolve_spec = (from: string, spec: string): string | undefined => {
	if (!spec.startsWith(".")) return undefined;
	const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
	const base = `${dir === "" ? "" : `${dir}/`}${spec.replace("./", "")}`;
	return base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : base;
};

const barrel_closure = (ctx: Ctx): ReadonlySet<string> => {
	const closure = new Set<string>(BARRELS);
	let grew = true;
	while (grew) {
		grew = false;
		for (const file of Array.from(closure))
			for (const m of (ctx.texts.get(file) ?? "").matchAll(REEXPORT_RE)) {
				const spec = m.at(1) ?? "";
				const target = spec === "" ? undefined : resolve_spec(file, spec);
				if (target !== undefined && ctx.texts.has(target) && !closure.has(target)) {
					closure.add(target);
					grew = true;
				}
			}
	}
	return closure;
};

const is_public = (name: string, closure: ReadonlySet<string>, ctx: Ctx): boolean =>
	[...closure].some((file) =>
		(ctx.texts.get(file) ?? "")
			.split("\n")
			.some((line) => line.trimStart().startsWith("export") && new RegExp(`\\b${escape_re(name)}\\b`).test(line)),
	);

const is_referenced = (name: string, file: string, ctx: Ctx): boolean => {
	const re = new RegExp(`\\b${escape_re(name)}\\b`);
	return ctx.files.some(
		(other) => other !== file && is_ts_corpus(other) && ctx.texts.has(other) && re.test(ctx.texts.get(other) ?? ""),
	);
};

const unused_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const closure = barrel_closure(ctx);
	const candidates: string[] = [];
	for (const file of ctx.files.filter(is_lib_source).toSorted()) {
		const source = ctx.texts.get(file);
		if (source === undefined || closure.has(file)) continue;
		for (const name of [...new Set(exported_names(source))].toSorted())
			if (!is_public(name, closure, ctx) && !is_referenced(name, file, ctx)) candidates.push(`${name} (${file})`);
	}
	const header = "candidates — simple text-reference heuristic, verify before deleting:";
	return ok(
		candidates.length === 0 ? "no unused-export candidates" : [header, ...candidates.map((c) => `  - ${c}`)].join("\n"),
	);
};

// --- AGENTS.md layout drift -------------------------------------------------

const is_layout_tracked = (p: string): boolean =>
	(p.endsWith(".ts") || p.endsWith(".js")) &&
	!p.startsWith("tests/") &&
	!p.startsWith("docs/") &&
	!p.includes("node_modules/") &&
	p !== "eslint.config.ts";

const parse_layout_block = (agents: string): readonly string[] => {
	const at = agents.indexOf("## Layout");
	if (at === -1) return [];
	const open = agents.indexOf("```", at);
	const close = open === -1 ? -1 : agents.indexOf("```", open + 3);
	if (open === -1 || close === -1) return [];
	return agents.slice(open + 3, close).split("\n");
};

type TreeLine = { readonly depth: number; readonly name: string; readonly note: string };

const parse_tree_line = (line: string): TreeLine | undefined => {
	let depth = 0;
	let i = 0;
	while (line[i] === "│" || line[i] === "|") {
		depth += 1;
		i += 4;
	}
	const m = /^(?:[├└]── )(.+)$/.exec(line.slice(i));
	if (m === null) return undefined;
	const raw = m.at(1) ?? "";
	const name = raw.split(/\s+#/, 1)[0]?.trim() ?? "";
	return { depth, name, note: raw.slice(raw.indexOf("#") + 1) };
};

// a layout dir whose description contains this marker covers every file under it
const DIR_COVERS = "files not listed individually";

const layout_tree_entries = (
	block: readonly string[],
): readonly { readonly path: string; readonly covers: boolean }[] => {
	const paths: { path: string; covers: boolean }[] = [];
	const stack: string[] = [];
	for (const line of block) {
		const entry = parse_tree_line(line);
		if (entry === undefined) continue;
		const full = [...stack.slice(0, entry.depth), entry.name].join("");
		if (entry.name.endsWith("/")) stack[entry.depth] = full;
		paths.push({ path: full, covers: entry.name.endsWith("/") && entry.note.includes(DIR_COVERS) });
	}
	return paths;
};

const basename_of = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

const drift_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const agents = ctx.texts.get("AGENTS.md") ?? "";
	const block = parse_layout_block(agents);
	if (block.length === 0) return err("no ``` layout block under ## Layout in AGENTS.md");
	const mentioned = block.join("\n");
	const entries = layout_tree_entries(block);
	const covered = entries.filter((e) => e.covers).map((e) => e.path);
	const stale = entries
		.map((e) => e.path)
		.filter((p) => p !== "." && !existsSync(join(repo_root, p)))
		.map((p) => `${p} (in layout, not on disk)`);
	const unmentioned = ctx.files
		.filter(is_layout_tracked)
		.toSorted()
		.filter(
			(p) => !covered.some((dir) => p.startsWith(dir)) && !mentioned.includes(p) && !mentioned.includes(basename_of(p)),
		)
		.map((p) => `${p} (tracked, not in layout)`);
	const lines = [
		`${String(stale.length)} stale layout path(s), ${String(unmentioned.length)} unmentioned file(s)`,
		...stale.map((p) => `  - ${p}`),
		...unmentioned.map((p) => `  - ${p}`),
	];
	return ok(lines.join("\n"));
};

// --- open work ---------------------------------------------------------------

const HEADER_RE = /<header>([\s\S]*?)<\/header>/g;
const H3_RE = /<h[13]>([\s\S]*?)<\/h[13]>/;
const OPEN_BADGE_RE = /class="badge (?:todo|doing|blocked)"/;

const plans_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const lines: string[] = [];
	for (const plan of ctx.files.filter((p) => p.startsWith(".plans/") && p.endsWith(".html")).toSorted()) {
		const source = ctx.texts.get(plan);
		if (source === undefined) continue;
		for (const header of source.matchAll(HEADER_RE)) {
			const body = header.at(1) ?? "";
			if (!OPEN_BADGE_RE.test(body)) continue;
			const h3 = H3_RE.exec(body)?.at(1) ?? "";
			const title = h3 === "" ? "(untitled)" : h3.replace(/<[^>]+>/g, "").trim();
			lines.push(`  - ${plan}: ${title}`);
		}
	}
	return ok(lines.length === 0 ? "  no open badge-status items in .plans/*.html" : lines.join("\n"));
};

const as_text = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

const devpad_section = async (): Promise<Result<string, string>> => {
	const res = await run(["devpad", "tasks", "list", "-p", devpad_project], {
		cwd: repo_root,
		timeout_ms: devpad_timeout_ms,
	});
	if (res.code !== 0) return ok("  devpad: unavailable");
	const parsed = await try_catch_async(
		async () => JSON.parse(res.stdout) as unknown,
		() => "unparseable output",
	);
	if (!parsed.ok) return ok(`  devpad: ${parsed.error}`);
	const raw: unknown = Array.isArray(parsed.value) ? parsed.value : (parsed.value as { tasks?: unknown }).tasks;
	if (!Array.isArray(raw)) return ok("  devpad: unexpected output shape");
	const field_of = (t: Record<string, unknown>, keys: readonly string[]): string => {
		for (const k of keys) {
			const v = as_text(t[k]);
			if (v !== "") return v;
		}
		return "";
	};
	const open = raw
		.map((t) => {
			const row = t as Record<string, unknown>;
			// `devpad tasks list` wraps each row as { task, codebase_tasks, tags }
			return typeof row.task === "object" && row.task !== null ? (row.task as Record<string, unknown>) : row;
		})
		.filter((t) => field_of(t, ["progress", "status", "state"]).toUpperCase() !== "COMPLETED")
		.map((t) => {
			const id = field_of(t, ["id"]) || "?";
			const title = field_of(t, ["title", "name"]) || "(untitled)";
			const status = field_of(t, ["progress", "status", "state"]) || "?";
			return `  - ${id}: ${title} [${status}]`;
		});
	return ok(open.length === 0 ? "  no open devpad tasks" : open.join("\n"));
};

const open_work_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const [plans, devpad] = await Promise.all([plans_section(ctx), devpad_section()]);
	const plans_text = plans.ok ? plans.value : `  error: ${plans.error}`;
	const devpad_text = devpad.ok ? devpad.value : `  error: ${devpad.error}`;
	return ok(`plans:\n${plans_text}\ndevpad:\n${devpad_text}`);
};

// --- README todo count -------------------------------------------------------

const readme_section = async (ctx: Ctx): Promise<Result<string, string>> => {
	const source = ctx.texts.get("README.md");
	if (source === undefined || !source.includes("## todo")) return err("README.md has no ## todo section");
	const todo = source.slice(source.indexOf("## todo"));
	const count = todo.split("\n").filter((l) => /^\s*[-*] \[[ x]\]/.test(l)).length;
	return ok(`${String(count)} open item(s) in README ## todo`);
};

// --- main ---------------------------------------------------------------------

type Section = { readonly title: string; readonly render: (ctx: Ctx) => Promise<Result<string, string>> };

const sections: readonly Section[] = [
	{ title: "Markers (TODO/FIXME/HACK/XXX)", render: markers_section },
	{ title: "Unused export candidates", render: unused_section },
	{ title: "AGENTS.md layout drift", render: drift_section },
	{ title: "Open work", render: open_work_section },
	{ title: "README ## todo", render: readme_section },
];

const main = async (): Promise<number> => {
	const files = await tracked_files();
	if (!files.ok) {
		process.stderr.write(`health: ${files.error}\n`);
		return 2;
	}
	const texts = await read_texts(files.value.filter((p) => is_scannable(p) || is_ts_corpus(p)));
	const ctx: Ctx = { files: files.value, texts };
	for (const section of sections) {
		const result = await section.render(ctx);
		out(`\n## ${section.title}`);
		out(result.ok ? result.value : `  error: ${result.error}`);
	}
	return 0;
};

process.exitCode = await main();
