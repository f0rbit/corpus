import type { CorpusError } from "../types.js";
import { create_ansi, BOX, TREE } from "./ansi.js";
import type { Ansi } from "./ansi.js";
import { create_spinner } from "./spinner.js";

export type SpinnerHandle = {
	update: (label: string) => void;
	stop: (final?: string) => void;
};

export type Output = {
	line: (text: string) => void;
	table: (rows: Record<string, string>[], columns: string[]) => void;
	json: (value: unknown) => void;
	error: (err: CorpusError | string) => void;
	bytes: (data: Uint8Array) => void;
	note: (text: string) => void;
	spinner: (label: string) => SpinnerHandle;
};

type CapturedCall =
	| { type: "line"; text: string }
	| { type: "table"; rows: Record<string, string>[]; columns: string[] }
	| { type: "json"; value: unknown }
	| { type: "error"; err: CorpusError | string }
	| { type: "bytes"; data: Uint8Array }
	| { type: "note"; text: string }
	| { type: "spinner_start"; label: string }
	| { type: "spinner_update"; label: string }
	| { type: "spinner_stop"; final?: string };

export type CaptureOutput = Output & {
	calls: CapturedCall[];
};

// Constructor options for the real CLI output. TTY/env facts and the write
// sinks are all injected rather than read ambiently — cli/index.ts computes
// the enable matrix once (colour, spinner) and passes plain booleans in, and
// tests inject sinks to assert on rendered bytes without mocking anything.
export type OutputOpts = {
	json: boolean;
	quiet: boolean;
	stdout_is_tty: boolean;
	stderr_is_tty: boolean;
	no_color: boolean;
	ci: boolean;
	stdout_write?: (chunk: string | Uint8Array) => void;
	stderr_write?: (chunk: string) => void;
};

export function create_console_output(opts: OutputOpts): Output {
	const color = opts.stdout_is_tty && !opts.json && !opts.no_color;
	const spinner_enabled = opts.stderr_is_tty && !opts.json && !opts.quiet && !opts.ci && !opts.no_color;
	const ansi = create_ansi(color);

	const stdout_write =
		opts.stdout_write ??
		((chunk: string | Uint8Array): void => {
			process.stdout.write(chunk);
		});
	const stderr_write =
		opts.stderr_write ??
		((chunk: string): void => {
			process.stderr.write(chunk);
		});

	return {
		line(text: string): void {
			if (opts.json) return;
			stdout_write(`${text}\n`);
		},
		table(rows: Record<string, string>[], columns: string[]): void {
			if (opts.json) {
				stdout_write(`${JSON.stringify(rows, null, 2)}\n`);
				return;
			}

			const widths = compute_widths(rows, columns);
			const lines = color ? render_color_table(rows, columns, widths, ansi) : render_plain_table(rows, columns, widths);
			for (const line of lines) stdout_write(`${line}\n`);
		},
		json(value: unknown): void {
			stdout_write(`${JSON.stringify(value, null, 2)}\n`);
		},
		error(err: CorpusError | string): void {
			if (opts.json) {
				const doc =
					typeof err === "string" ? { kind: "error", message: err } : { kind: err.kind, message: describe_error(err) };
				stdout_write(`${JSON.stringify({ error: doc }, null, 2)}\n`);
				return;
			}
			stderr_write(`${typeof err === "string" ? err : format_error(err)}\n`);
		},
		bytes(data: Uint8Array): void {
			stdout_write(data);
		},
		note(text: string): void {
			if (opts.quiet || opts.json) return;
			stdout_write(`${ansi.dim(text)}\n`);
		},
		spinner(label: string): SpinnerHandle {
			const spin = create_spinner({ write: stderr_write, enabled: spinner_enabled });
			spin.start(label);
			return { update: spin.update, stop: spin.stop };
		},
	};
}

// Last-resort sink for errors thrown outside the Result path. One line by
// default; stack only under CORPUS_DEBUG=1 (flag injected, not read here).
export function write_fatal(error: unknown, debug: boolean, write?: (chunk: string) => void): void {
	const sink =
		write ??
		((chunk: string): void => {
			process.stderr.write(chunk);
		});
	const message = error instanceof Error ? error.message : String(error);
	sink(`corpus: ${message}\n`);
	if (debug && error instanceof Error && error.stack) sink(`${error.stack}\n`);
}

export function create_capture_output(): CaptureOutput {
	const calls: CapturedCall[] = [];

	return {
		calls,
		line(text: string): void {
			calls.push({ type: "line", text });
		},
		table(rows: Record<string, string>[], columns: string[]): void {
			calls.push({ type: "table", rows, columns });
		},
		json(value: unknown): void {
			calls.push({ type: "json", value });
		},
		error(err: CorpusError | string): void {
			calls.push({ type: "error", err });
		},
		bytes(data: Uint8Array): void {
			calls.push({ type: "bytes", data });
		},
		note(text: string): void {
			calls.push({ type: "note", text });
		},
		spinner(label: string): SpinnerHandle {
			calls.push({ type: "spinner_start", label });
			return {
				update(next_label: string): void {
					calls.push({ type: "spinner_update", label: next_label });
				},
				stop(final?: string): void {
					calls.push({ type: "spinner_stop", final });
				},
			};
		},
	};
}

function compute_widths(rows: Record<string, string>[], columns: string[]): Map<string, number> {
	const widths = new Map<string, number>();
	for (const col of columns) {
		widths.set(col, col.length);
	}
	for (const row of rows) {
		for (const col of columns) {
			const val = row[col] ?? "";
			const current = widths.get(col) ?? 0;
			widths.set(col, Math.max(current, val.length));
		}
	}
	return widths;
}

// Plain aligned columns; only trailing padding is trimmed per line.
function render_plain_table(rows: Record<string, string>[], columns: string[], widths: Map<string, number>): string[] {
	const header = columns.map((col) => col.padEnd(widths.get(col) ?? 0)).join("  ");
	const divider = columns.map((col) => "-".repeat(widths.get(col) ?? 0)).join("  ");
	const body = rows.map((row) => columns.map((col) => (row[col] ?? "").padEnd(widths.get(col) ?? 0)).join("  "));
	return [header, divider, ...body].map((line) => line.trimEnd());
}

function plain_text(text: string): string {
	return text;
}

function render_color_table(
	rows: Record<string, string>[],
	columns: string[],
	widths: Map<string, number>,
	ansi: Ansi,
): string[] {
	const width_of = (col: string): number => widths.get(col) ?? 0;

	const border = (left: string, joiner: string, right: string): string =>
		ansi.dim(left + columns.map((col) => BOX.horizontal.repeat(width_of(col) + 2)).join(joiner) + right);

	const data_row = (cells: string[], style: (text: string) => string): string => {
		const padded_cells = columns.map((col, i) => ` ${style((cells[i] ?? "").padEnd(width_of(col)))} `);
		return ansi.dim(BOX.vertical) + padded_cells.join(ansi.dim(BOX.vertical)) + ansi.dim(BOX.vertical);
	};

	const lines = [
		border(BOX.top_left, BOX.mid_top, BOX.top_right),
		data_row(columns, ansi.bold),
		...rows.map((row) =>
			data_row(
				columns.map((col) => row[col] ?? ""),
				plain_text,
			),
		),
		border(BOX.bottom_left, BOX.mid_bottom, BOX.bottom_right),
	];
	return lines;
}

export type TreeNode = {
	label: string;
	children: TreeNode[];
};

export function render_tree(root: TreeNode): string[] {
	const lines = [root.label];
	render_tree_children(root.children, "", lines);
	return lines;
}

function render_tree_children(nodes: TreeNode[], prefix: string, lines: string[]): void {
	for (const [index, node] of nodes.entries()) {
		const is_last = index === nodes.length - 1;
		lines.push(`${prefix}${is_last ? TREE.last : TREE.branch}${node.label}`);
		render_tree_children(node.children, `${prefix}${is_last ? TREE.gap : TREE.pipe}`, lines);
	}
}

const MAX_CAUSE_LENGTH = 200;

// First line only, bounded: drizzle's "Failed query" messages append the full
// SQL and params after a newline.
function brief(message: string): string {
	const first_line = message.split("\n")[0] ?? message;
	return first_line.length > MAX_CAUSE_LENGTH ? `${first_line.slice(0, MAX_CAUSE_LENGTH)}...` : first_line;
}

function innermost(error: Error): Error {
	return error.cause instanceof Error ? innermost(error.cause) : error;
}

// The wrapper message plus the innermost cause when it adds information
// (drizzle wraps the real failure, e.g. an HTTP 401, in a "Failed query").
function with_cause(error: Error): string {
	const root = innermost(error);
	return root === error ? brief(error.message) : `${brief(error.message)} — caused by: ${brief(root.message)}`;
}

// Bare, prefix-free message — the `message` of the --json error document.
function describe_error(err: CorpusError): string {
	switch (err.kind) {
		case "not_found":
			if (err.version === "") return `store "${err.store_id}" not found${err.message ? ` (${err.message})` : ""}`;
			return `Version ${err.version} not found in store ${err.store_id}${err.message ? ` (${err.message})` : ""}`;
		case "already_exists":
			return `Version ${err.version} already exists in store ${err.store_id}`;
		case "storage_error":
			return `Storage error during ${err.operation}: ${with_cause(err.cause)}`;
		case "decode_error":
			return `Failed to decode data: ${with_cause(err.cause)}`;
		case "encode_error":
			return `Failed to encode data: ${with_cause(err.cause)}`;
		case "hash_mismatch":
			return `Content hash mismatch (expected ${err.expected}, got ${err.actual})`;
		case "invalid_config":
			return err.message;
		case "validation_error":
			return `Validation failed: ${err.message}`;
		case "observation_not_found":
			return `Observation ${err.id} not found`;
		case "transaction_aborted":
			return `Transaction aborted (${err.reason})${err.cause ? `: ${with_cause(err.cause)}` : ""}`;
		case "partial_commit":
			return `Partial commit (${String(err.ops_completed)} succeeded, ${String(err.ops_failed)} failed): ${with_cause(err.cause)}`;
		case "concurrent_modification":
			return `Concurrent modification detected in version ${err.version} of store ${err.store_id}`;
	}
}

function format_error(err: CorpusError): string {
	return `error: ${describe_error(err)}`;
}
