import { isAbsolute, relative, resolve } from "node:path";

export type FileCoverage = { lines: Set<number>; fnh: number; fnf: number };
export type Coverage = Map<string, FileCoverage>;

const excluded = ["tests/", "docs/", "scripts/", "node_modules/"];

const normalise = (root: string, sf: string): string | undefined => {
	const rel = relative(root, isAbsolute(sf) ? sf : resolve(root, sf));
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return excluded.some((prefix) => rel.startsWith(prefix)) ? undefined : rel;
};

const field = (record: string, key: string): string[] =>
	record
		.split("\n")
		.filter((line) => line.startsWith(`${key}:`))
		.map((line) => line.slice(key.length + 1).trim());

const to_int = (values: string[]): number => values.reduce((sum, v) => sum + (Number.parseInt(v, 10) || 0), 0);

const parse_record = (root: string, record: string): readonly [string, FileCoverage] | undefined => {
	const sf = field(record, "SF")[0];
	const path = sf === undefined ? undefined : normalise(root, sf);
	if (path === undefined) return undefined;
	const hit_lines = field(record, "DA")
		.map((da) => da.split(","))
		.filter(([, hits]) => Number.parseInt(hits ?? "0", 10) > 0)
		.map(([line]) => Number.parseInt(line ?? "", 10));
	return [path, { lines: new Set(hit_lines), fnh: to_int(field(record, "FNH")), fnf: to_int(field(record, "FNF")) }];
};

const merge = (a: FileCoverage | undefined, b: FileCoverage): FileCoverage =>
	a === undefined
		? b
		: { lines: new Set([...a.lines, ...b.lines]), fnh: Math.max(a.fnh, b.fnh), fnf: Math.max(a.fnf, b.fnf) };

export const parse_lcov = (root: string, lcov: string): Coverage =>
	lcov
		.split("end_of_record")
		.map((record) => parse_record(root, record))
		.reduce<Coverage>((acc, entry) => {
			if (entry === undefined) return acc;
			acc.set(entry[0], merge(acc.get(entry[0]), entry[1]));
			return acc;
		}, new Map());
