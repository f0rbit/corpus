// Pure ANSI styling helpers. No console/process access — callers decide
// whether decoration is enabled (see cli/output.ts's enable-matrix) and pass
// that decision in. Disabled mode returns identity functions so callers never
// branch on `enabled` themselves.

export type Ansi = {
	bold: (text: string) => string;
	dim: (text: string) => string;
	cyan: (text: string) => string;
	green: (text: string) => string;
	yellow: (text: string) => string;
	red: (text: string) => string;
	magenta: (text: string) => string;
};

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

function style(code: number): (text: string) => string {
	return (text: string): string => `${ESC}${String(code)}m${text}${RESET}`;
}

function identity(text: string): string {
	return text;
}

export function create_ansi(enabled: boolean): Ansi {
	if (!enabled) {
		return {
			bold: identity,
			dim: identity,
			cyan: identity,
			green: identity,
			yellow: identity,
			red: identity,
			magenta: identity,
		};
	}

	return {
		bold: style(1),
		dim: style(2),
		red: style(31),
		green: style(32),
		yellow: style(33),
		magenta: style(35),
		cyan: style(36),
	};
}

// Box-drawing borders for cli/output.ts's coloured table renderer.
export const BOX = {
	horizontal: "─",
	vertical: "│",
	top_left: "┌",
	top_right: "┐",
	bottom_left: "└",
	bottom_right: "┘",
	mid_left: "├",
	mid_right: "┤",
	mid_top: "┬",
	mid_bottom: "┴",
} as const;

// Tree connectors for cli/output.ts's render_tree (consumed by task 5.1's
// lineage command).
export const TREE = {
	branch: "├─ ",
	last: "└─ ",
	pipe: "│  ",
	gap: "   ",
} as const;
