import type { CorpusError } from "../types.js";

export type Output = {
	line(text: string): void;
	table(rows: Record<string, string>[], columns: string[]): void;
	json(value: unknown): void;
	error(err: CorpusError | string): void;
	bytes(data: Uint8Array): void;
};

type CapturedCall =
	| { type: "line"; text: string }
	| { type: "table"; rows: Record<string, string>[]; columns: string[] }
	| { type: "json"; value: unknown }
	| { type: "error"; err: CorpusError | string }
	| { type: "bytes"; data: Uint8Array };

export type CaptureOutput = Output & {
	calls: CapturedCall[];
};

export function create_console_output(opts: { json_mode: boolean }): Output {
	return {
		line(text: string): void {
			if (!opts.json_mode) {
				console.log(text);
			}
		},
		table(rows: Record<string, string>[], columns: string[]): void {
			if (opts.json_mode) {
				console.log(JSON.stringify(rows, null, 2));
			} else {
				// Calculate column widths
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

				// Print header
				const header = columns.map((col) => col.padEnd(widths.get(col) ?? 0)).join("  ");
				console.log(header);
				console.log(columns.map((col) => "-".repeat(widths.get(col) ?? 0)).join("  "));

				// Print rows
				for (const row of rows) {
					const line = columns.map((col) => (row[col] ?? "").padEnd(widths.get(col) ?? 0)).join("  ");
					console.log(line);
				}
			}
		},
		json(value: unknown): void {
			console.log(JSON.stringify(value, null, 2));
		},
		error(err: CorpusError | string): void {
			const msg = typeof err === "string" ? err : format_error(err);
			if (opts.json_mode) {
				console.log(
					JSON.stringify(
						{
							error: typeof err === "string" ? err : err.kind,
							message: msg,
						},
						null,
						2,
					),
				);
			} else {
				console.error(msg);
			}
		},
		bytes(data: Uint8Array): void {
			process.stdout.write(data);
		},
	};
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
	};
}

function format_error(err: CorpusError): string {
	switch (err.kind) {
		case "not_found":
			return `error: Version ${err.version} not found in store ${err.store_id}${err.message ? ` (${err.message})` : ""}`;
		case "already_exists":
			return `error: Version ${err.version} already exists in store ${err.store_id}`;
		case "storage_error":
			return `error: Storage error during ${err.operation}: ${err.cause.message}`;
		case "decode_error":
			return `error: Failed to decode data: ${err.cause.message}`;
		case "encode_error":
			return `error: Failed to encode data: ${err.cause.message}`;
		case "hash_mismatch":
			return `error: Content hash mismatch (expected ${err.expected}, got ${err.actual})`;
		case "invalid_config":
			return `error: ${err.message}`;
		case "validation_error":
			return `error: Validation failed: ${err.message}`;
		case "observation_not_found":
			return `error: Observation ${err.id} not found`;
		case "transaction_aborted":
			return `error: Transaction aborted (${err.reason})${err.cause ? `: ${err.cause.message}` : ""}`;
		case "partial_commit":
			return `error: Partial commit (${String(err.ops_completed)} succeeded, ${String(err.ops_failed)} failed): ${err.cause.message}`;
		case "concurrent_modification":
			return `error: Concurrent modification detected in version ${err.version} of store ${err.store_id}`;
	}
}
