export type ContentDiff = { lost: number[]; removed: number[]; gained: number[] };

const noise = new Set(["}", "};", ")", "});", "]"]);

export const line_keys = (src: string): (string | undefined)[] => {
	const counts = new Map<string, number>();
	return src.split("\n").map((raw) => {
		const text = raw.trim();
		if (text === "" || noise.has(text)) return undefined;
		const k = counts.get(text) ?? 0;
		counts.set(text, k + 1);
		return `${text}\u0000${String(k)}`;
	});
};

const covered = (keys: readonly (string | undefined)[], lines: ReadonlySet<number>): Map<string, number> =>
	new Map(
		[...lines].flatMap((n) => {
			const key = keys[n - 1];
			return key === undefined ? [] : [[key, n] as const];
		}),
	);

export const content_diff = (
	base_src: string,
	base_lines: ReadonlySet<number>,
	head_src: string,
	head_lines: ReadonlySet<number>,
): ContentDiff => {
	const head_keys = line_keys(head_src);
	const base_covered = covered(line_keys(base_src), base_lines);
	const head_covered = covered(head_keys, head_lines);
	const head_at = new Map(head_keys.flatMap((key, i) => (key === undefined ? [] : [[key, i + 1] as const])));
	const missing = [...base_covered].filter(([key]) => !head_covered.has(key));
	const lost = missing.filter(([key]) => head_at.has(key)).map(([key]) => head_at.get(key) ?? 0);
	const removed = missing.filter(([key]) => !head_at.has(key)).map(([, n]) => n);
	const gained = [...head_covered].filter(([key]) => !base_covered.has(key)).map(([, n]) => n);
	return { lost, removed, gained };
};
