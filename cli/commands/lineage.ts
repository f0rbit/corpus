import type { Command, CommandContext } from "./index.js";
import type { Result, CorpusError } from "../../types.js";
import { ok, err } from "../../types.js";
import { resolve_backend } from "../resolve-backend.js";
import { sniff_wrangler } from "../wrangler.js";
import { load_cli_config } from "../load-config.js";
import { render_tree } from "../output.js";
import type { TreeNode } from "../output.js";
import type { ParentRef } from "../../types.js";

type LineageNode = {
	store: string;
	version: string;
	depth: number;
	parents: ParentRef[];
	missing?: boolean;
};

export const lineage_command: Command = {
	name: "lineage",
	summary: "Show parent lineage for a snapshot version",
	spec: {
		positionals: ["store", "version"],
		options: {
			depth: { type: "string" },
		},
	},
	async run(ctx: CommandContext): Promise<Result<void, CorpusError>> {
		const store_id = ctx.positionals[0];
		const version = ctx.positionals[1];

		if (!store_id || !version) {
			return err({
				kind: "validation_error",
				message: "store and version arguments are required",
				cause: new Error("missing positional arguments"),
			});
		}

		let max_depth = 10;
		if (typeof ctx.args.depth === "string") {
			const parsed = parseInt(ctx.args.depth, 10);
			if (isNaN(parsed) || parsed < 1) {
				return err({
					kind: "validation_error",
					message: "invalid --depth: must be a positive number",
					cause: new Error("depth must be >= 1"),
				});
			}
			max_depth = parsed;
		}

		let backend = ctx._test_backend;

		if (!backend) {
			const wrangler_result = await sniff_wrangler(ctx.cwd);
			if (!wrangler_result.ok) return wrangler_result;
			const wrangler = wrangler_result.value;

			const config_result = await load_cli_config(ctx.cwd);
			if (!config_result.ok) return config_result;
			const config = config_result.value;

			const backend_result = await resolve_backend(ctx.backend_selector, wrangler, {
				config,
				env_vars: ctx.env_vars,
				cwd: ctx.cwd,
			});
			if (!backend_result.ok) return backend_result;

			backend = backend_result.value;
		}

		// Confirm the root exists before walking — a missing root is a real
		// error, not a lineage fact (missing ANCESTORS render as `(missing)`).
		const root_result = await backend.metadata.get(store_id, version);
		if (!root_result.ok) return root_result;

		const nodes: LineageNode[] = [];
		const seen = new Set<string>();
		const spin = ctx.output.spinner("Loading lineage...");

		const visit = async (store: string, ver: string, depth: number): Promise<void> => {
			if (depth > max_depth) return;

			const key = `${store}/${ver}`;
			if (seen.has(key)) return;
			seen.add(key);

			const meta_res = await backend.metadata.get(store, ver);
			if (!meta_res.ok) {
				nodes.push({ store, version: ver, depth, parents: [], missing: true });
				return;
			}

			const meta = meta_res.value;
			nodes.push({
				store: meta.store_id,
				version: meta.version,
				depth,
				parents: meta.parents,
			});

			for (const parent of meta.parents) {
				await visit(parent.store_id, parent.version, depth + 1);
			}
		};

		await visit(store_id, version, 0);
		spin.stop();

		if (ctx.json) {
			ctx.output.json({
				root: { store: store_id, version },
				nodes: nodes.map((node) => ({
					store: node.store,
					version: node.version,
					depth: node.depth,
					parents: node.parents,
					...(node.missing ? { missing: true } : {}),
				})),
			});
			return ok(undefined);
		}

		// `nodes` is a flat list keyed by store/version (one entry per node
		// `visit` reached, cycle-guarded via `seen`) — it does NOT encode the
		// tree shape. Re-deriving the tree by `parents` lookups here means the
		// SAME node object can be found again from a different branch (a real
		// cycle, since `seen` only stopped `visit` from re-fetching it, not
		// from being referenced as a parent again). `path` tracks the chain of
		// ancestors currently being expanded on THIS branch — revisiting one of
		// those is a genuine cycle and renders a terminal `(cycle)` marker
		// instead of recursing. A diamond (same ancestor reached via two
		// DIFFERENT branches, not on either's current path) still renders in
		// full on both branches — that's a legitimate re-render, not a cycle.
		const build_tree = (node: LineageNode, path: ReadonlySet<string>): TreeNode => {
			const key = `${node.store}/${node.version}`;
			const label = node.missing
				? `${node.store}/${node.version} (missing)`
				: path.has(key)
					? `${node.store}/${node.version} (cycle)`
					: `${node.store}/${node.version}`;

			if (path.has(key)) {
				return { label, children: [] };
			}

			const next_path = new Set(path).add(key);
			const children: TreeNode[] = [];

			for (const parent of node.parents) {
				const parent_node = nodes.find((n) => n.store === parent.store_id && n.version === parent.version);
				if (parent_node && node.depth < max_depth) {
					children.push(build_tree(parent_node, next_path));
				}
			}

			return { label, children };
		};

		const root_node = nodes[0];
		if (!root_node) {
			return err({
				kind: "storage_error",
				operation: "get",
				cause: new Error("failed to load root node"),
			});
		}

		for (const line of render_tree(build_tree(root_node, new Set()))) {
			ctx.output.line(line);
		}

		return ok(undefined);
	},
};
