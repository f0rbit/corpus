import { describe, expect, test } from "bun:test";
import { content_diff } from "../../scripts/lib/content-key.js";

const lines = (...n: number[]): Set<number> => new Set(n);

describe("content_diff", () => {
	test("an insertion above covered code is not a loss", () => {
		const d = content_diff("a();\nb();\nc();", lines(1, 2, 3), "x();\ny();\nz();\na();\nb();\nc();", lines(4, 5, 6));
		expect(d).toEqual({ lost: [], removed: [], gained: [] });
	});

	test("an edited covered line is removed, not lost", () => {
		const d = content_diff("a();\nb();", lines(1, 2), "a();\nb2();", lines(1, 2));
		expect(d.lost).toEqual([]);
		expect(d.removed).toEqual([2]);
		expect(d.gained).toEqual([2]);
	});

	test("duplicated text keeps its occurrence index", () => {
		const d = content_diff("f();\nf();", lines(2), "f();\nf();", lines(1));
		expect(d.lost).toEqual([2]);
		expect(d.gained).toEqual([1]);
	});

	test("uncovering an unchanged line is a loss at its head position", () => {
		const d = content_diff("a();\nb();", lines(1, 2), "z();\na();\nb();", lines(2));
		expect(d).toEqual({ lost: [3], removed: [], gained: [] });
	});

	test("re-indenting does not change a line's identity", () => {
		const d = content_diff("a();", lines(1), "\t\ta();", lines(1));
		expect(d).toEqual({ lost: [], removed: [], gained: [] });
	});

	test("brace-only lines are noise", () => {
		const d = content_diff("a();\n}\n});", lines(1, 2, 3), "a();", lines(1));
		expect(d).toEqual({ lost: [], removed: [], gained: [] });
	});
});
