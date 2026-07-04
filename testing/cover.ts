/**
 * @module testing/cover
 * @description Hedgehog-style coverage assertion for property-based tests.
 *
 * Declare "this generator must produce values matching label X at least N% of
 * the time" via {@link cover_property}. Hit counts are tallied per-label as
 * fast-check samples the underlying arbitrary; once the property completes
 * successfully, any shortfall raises a {@link CoverageError} listing every
 * label's observed proportion against its minimum.
 *
 * Coverage state is local to a single `cover_property` call — there is no
 * module-global registry — so labels never leak between tests.
 *
 * Reference: Hedgehog's `cover` combinator (see Hackage docs).
 */

import fc from "fast-check";
import type { Arbitrary } from "fast-check";

/**
 * A single coverage requirement.
 *
 * - `name`        — human label surfaced in error messages.
 * - `min_percent` — minimum observed proportion (0..100 inclusive).
 * - `matches`     — predicate over the generated sample; truthy → count as hit.
 */
export type CoverageLabel<T> = {
	name: string;
	min_percent: number;
	matches: (sample: T) => boolean;
};

/**
 * Per-label coverage report. Returned inside {@link CoverageError} for callers
 * that need to inspect numbers programmatically.
 */
export type CoverageStat = {
	name: string;
	hits: number;
	total: number;
	observed_percent: number;
	min_percent: number;
	met: boolean;
};

/**
 * Thrown by {@link cover_property} when one or more labels failed to meet their
 * `min_percent` after the property ran successfully. The message lists ALL
 * labels (met + unmet) so failures are diagnosable from a single line of log
 * output.
 */
export class CoverageError extends Error {
	override readonly name = "CoverageError";
	readonly stats: readonly CoverageStat[];

	constructor(stats: readonly CoverageStat[]) {
		super(format_message(stats));
		this.stats = stats;
	}
}

/**
 * Default number of property runs when `opts.numRuns` is omitted.
 *
 * Set to 200 — the same default as the phase-1 backend round-trip pilot.
 * Coverage at 5% with 200 runs requires ≥ 10 hits, comfortable for typical
 * domain-error generators.
 */
export const DEFAULT_NUM_RUNS = 200;

/**
 * Run an `fc.asyncProperty(arb, predicate)` with `numRuns` (default
 * {@link DEFAULT_NUM_RUNS}) iterations, tallying hits per coverage label as
 * samples flow through. After the property completes:
 *
 * - If the property failed, fast-check's normal counterexample is re-thrown
 *   (the coverage report is suppressed — the bug comes first).
 * - If the property passed, each label's `(hits / total) * 100` is checked
 *   against its `min_percent`. Any shortfall raises {@link CoverageError}.
 *
 * Hit counting happens inside the wrapped predicate, NOT inside fast-check
 * internals — every sample fed to the predicate is also fed to every label's
 * `matches` callback.
 *
 * @example
 * ```ts
 * await testing.cover(
 *   fc.integer({ min: -100, max: 100 }),
 *   async (n) => n * 2 === n + n,
 *   {
 *     labels: [
 *       { name: "negative", min_percent: 30, matches: (n) => n < 0 },
 *       { name: "zero",     min_percent: 1,  matches: (n) => n === 0 },
 *       { name: "positive", min_percent: 30, matches: (n) => n > 0 },
 *     ],
 *   },
 * )
 * ```
 */
export async function cover_property<T>(
	arb: Arbitrary<T>,
	predicate: (sample: T) => boolean | Promise<boolean>,
	opts: {
		labels: ReadonlyArray<CoverageLabel<T>>;
		numRuns?: number;
	},
): Promise<void> {
	const num_runs = opts.numRuns ?? DEFAULT_NUM_RUNS;
	const tallies: HitTally<T>[] = opts.labels.map((label) => ({
		name: label.name,
		min_percent: label.min_percent,
		matches: label.matches,
		hits: 0,
		total: 0,
	}));

	const wrapped = async (sample: T): Promise<boolean> => {
		for (const tally of tallies) {
			tally.total += 1;
			if (tally.matches(sample)) tally.hits += 1;
		}
		return await predicate(sample);
	};

	await fc.assert(fc.asyncProperty(arb, wrapped), { numRuns: num_runs });

	const stats = tallies.map(to_stat);
	if (stats.some((s) => !s.met)) throw new CoverageError(stats);
}

type HitTally<T> = {
	name: string;
	min_percent: number;
	matches: (sample: T) => boolean;
	hits: number;
	total: number;
};

function to_stat<T>(tally: HitTally<T>): CoverageStat {
	const observed_percent = tally.total === 0 ? 0 : (tally.hits / tally.total) * 100;
	return {
		name: tally.name,
		hits: tally.hits,
		total: tally.total,
		observed_percent,
		min_percent: tally.min_percent,
		met: observed_percent >= tally.min_percent,
	};
}

function format_message(stats: readonly CoverageStat[]): string {
	const lines = stats.map((s) => {
		const status = s.met ? "OK  " : "FAIL";
		const observed = s.observed_percent.toFixed(2);
		const min = s.min_percent.toFixed(2);
		return `  [${status}] ${s.name}: observed ${observed}% (${String(s.hits)}/${String(s.total)}), required >= ${min}%`;
	});
	return `testing.cover: coverage shortfall\n${lines.join("\n")}`;
}
