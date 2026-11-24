import { describe, it, expect } from "bun:test";
import { parse_global_args, parse_command_args } from "../../cli/args.js";
import type { CommandSpec } from "../../cli/args.js";
import * as testing from "../../testing/index.js";

const fc = testing.fc;

type Item =
	| { k: "env"; v: string; form: "long" | "short" | "inline" }
	| { k: "json" }
	| { k: "quiet"; short: boolean }
	| { k: "counts" }
	| { k: "limit"; v: string; inline: boolean }
	| { k: "tag"; v: string; inline: boolean }
	| { k: "pos"; v: string };

const word = fc.stringMatching(/^[a-z0-9]{1,6}$/);

const global_item_arb = fc.oneof(
	fc.record({
		k: fc.constant("env" as const),
		v: word,
		form: fc.constantFrom("long" as const, "short" as const, "inline" as const),
	}),
	fc.constant({ k: "json" as const }),
	fc.record({ k: fc.constant("quiet" as const), short: fc.boolean() }),
);

const command_item_arb = fc.oneof(
	fc.constant({ k: "counts" as const }),
	fc.record({ k: fc.constant("limit" as const), v: word, inline: fc.boolean() }),
	fc.record({ k: fc.constant("tag" as const), v: word, inline: fc.boolean() }),
	fc.record({ k: fc.constant("pos" as const), v: word }),
);

const item_arb = fc.oneof(global_item_arb, command_item_arb);

const command_spec: CommandSpec = {
	options: {
		counts: { type: "boolean" },
		limit: { type: "string" },
		tag: { type: "string", multiple: true },
	},
};

function render(item: Item): string[] {
	switch (item.k) {
		case "env":
			return item.form === "long" ? ["--env", item.v] : item.form === "short" ? ["-e", item.v] : [`--env=${item.v}`];
		case "json":
			return ["--json"];
		case "quiet":
			return [item.short ? "-q" : "--quiet"];
		case "counts":
			return ["--counts"];
		case "limit":
		case "tag":
			return item.inline ? [`--${item.k}=${item.v}`] : [`--${item.k}`, item.v];
		case "pos":
			return [item.v];
	}
}

// Regression coverage for a real bug found during phase-5 verification:
// node:util.parseArgs's `strict: false` mode treats every UNCONFIGURED long
// option as a standalone boolean — it does not thread a following bare word
// through as that option's value. parse_global_args only configures the
// global flags (--env/--file/--config/--json/--quiet/--help), so any
// command-specific flag (--counts, --raw, --limit 5, --tag x, ...) used to
// come back split apart or silently dropped from what reached
// parse_command_args. `bun cli/index.ts stores --counts` rendered as if
// --counts had never been passed at all, and `cat --raw` fell through to
// the decode path instead of streaming raw bytes.

describe("parse_global_args + parse_command_args (two-stage CLI parse)", () => {
	it("globals are set exactly, and the command parse sees every non-global token in order", () => {
		fc.assert(
			fc.property(fc.array(global_item_arb, { maxLength: 3 }), fc.array(item_arb, { maxLength: 8 }), (prefix, rest) => {
				const items = [...prefix, ...rest];
				const argv = [...prefix.flatMap(render), "versions", ...rest.flatMap(render)];

				const global = parse_global_args(argv);
				const env_values = items.flatMap((i) => (i.k === "env" ? [i.v] : []));
				expect(global.command).toBe("versions");
				expect(global.env).toBe(env_values.at(-1));
				expect(global.json).toBe(items.some((i) => i.k === "json"));
				expect(global.quiet).toBe(items.some((i) => i.k === "quiet"));
				expect(global.file).toBeUndefined();
				expect(global.config).toBeUndefined();
				expect(global.help).toBe(false);

				const { args, positionals } = parse_command_args(global.positionals, command_spec);
				const limits = items.flatMap((i) => (i.k === "limit" ? [i.v] : []));
				const tags = items.flatMap((i) => (i.k === "tag" ? [i.v] : []));
				expect(args.counts).toBe(items.some((i) => i.k === "counts") ? true : undefined);
				expect(args.limit).toBe(limits.at(-1));
				expect(args.tag).toEqual(tags.length > 0 ? tags : undefined);
				expect(positionals).toEqual(items.flatMap((i) => (i.k === "pos" ? [i.v] : [])));
			}),
			{ numRuns: 300 },
		);
	});

	it("resolves the command name as the first true positional even when a command flag precedes it", () => {
		const global = parse_global_args(["--dry-run", "clone", "/a", "/b"]);
		expect(global.command).toBe("clone");
		expect(global.positionals).toEqual(["--dry-run", "/a", "/b"]);
	});

	it("still resolves global flags (short and long) regardless of position", () => {
		const global = parse_global_args(["stores", "-f", "/tmp/x", "--counts", "-q"]);
		expect(global.file).toBe("/tmp/x");
		expect(global.quiet).toBe(true);
		expect(global.positionals).toEqual(["--counts"]);
	});
});
