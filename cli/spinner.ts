// Pure braille-frame spinner. No console/process access — the write sink and
// the enabled decision are both injected by the caller (cli/output.ts wires
// the real stderr binding; tests inject a capturing sink). A disabled spinner
// is a full no-op so callers never need to branch on whether decoration is on.

export type Spinner = {
	start: (label: string) => void;
	update: (label: string) => void;
	stop: (final?: string) => void;
};

export type SpinnerOpts = {
	write: (text: string) => void;
	enabled: boolean;
	frames?: string[];
	interval_ms?: number;
};

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

export function create_spinner(opts: SpinnerOpts): Spinner {
	if (!opts.enabled) {
		return {
			start(): void {
				/* disabled: no-op */
			},
			update(): void {
				/* disabled: no-op */
			},
			stop(): void {
				/* disabled: no-op */
			},
		};
	}

	const frames = opts.frames ?? DEFAULT_FRAMES;
	const interval_ms = opts.interval_ms ?? DEFAULT_INTERVAL_MS;

	let frame_index = 0;
	let label = "";
	let last_line_length = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	const render = (): void => {
		const frame = frames[frame_index % frames.length] ?? "";
		const line = `${frame} ${label}`;
		opts.write(`\r${" ".repeat(last_line_length)}\r${line}`);
		last_line_length = line.length;
		frame_index += 1;
	};

	const erase = (): void => {
		if (last_line_length === 0) return;
		opts.write(`\r${" ".repeat(last_line_length)}\r`);
		last_line_length = 0;
	};

	return {
		start(initial_label: string): void {
			label = initial_label;
			frame_index = 0;
			render();
			timer = setInterval(render, interval_ms);
		},
		update(next_label: string): void {
			label = next_label;
		},
		stop(final?: string): void {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			erase();
			if (final !== undefined) {
				opts.write(`${final}\n`);
			}
		},
	};
}
