import { describe, it, expect } from "bun:test";
import { parse_global_args, parse_command_args } from "../../cli/args.js";
import type { CommandSpec } from "../../cli/args.js";

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
	it("threads a bare command-specific boolean flag through to the command parse", () => {
		const global = parse_global_args(["stores", "--file", "/tmp/x", "--counts"]);
		expect(global.command).toBe("stores");
		expect(global.file).toBe("/tmp/x");

		const spec: CommandSpec = { options: { counts: { type: "boolean" } } };
		const { args } = parse_command_args(global.positionals, spec);
		expect(args.counts).toBe(true);
	});

	it("preserves a space-separated value for a command-specific string flag", () => {
		const global = parse_global_args(["versions", "store_a", "--limit", "5", "--file", "/tmp/x"]);
		expect(global.command).toBe("versions");

		const spec: CommandSpec = { positionals: ["store"], options: { limit: { type: "string" } } };
		const { args, positionals } = parse_command_args(global.positionals, spec);
		expect(positionals).toEqual(["store_a"]);
		expect(args.limit).toBe("5");
	});

	it("preserves repeated multi-valued command-specific flags in order", () => {
		const global = parse_global_args(["versions", "store_a", "--tag", "a", "--tag", "b"]);

		const spec: CommandSpec = { positionals: ["store"], options: { tag: { type: "string", multiple: true } } };
		const { args } = parse_command_args(global.positionals, spec);
		expect(args.tag).toEqual(["a", "b"]);
	});

	it("supports inline --flag=value form for command-specific options", () => {
		const global = parse_global_args(["versions", "store_a", "--limit=9"]);

		const spec: CommandSpec = { positionals: ["store"], options: { limit: { type: "string" } } };
		const { args } = parse_command_args(global.positionals, spec);
		expect(args.limit).toBe("9");
	});

	it("does not leak command-specific flags into global values", () => {
		const global = parse_global_args(["cat", "store_a", "v1", "--raw", "--json"]);
		expect(global.json).toBe(true);
		expect(global.positionals).toEqual(["store_a", "v1", "--raw"]);
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
