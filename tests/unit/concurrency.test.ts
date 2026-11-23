import { describe, test, expect } from "bun:test";
import { Semaphore, parallel_map } from "../../concurrency.js";
import * as testing from "../../testing/index.js";

const fc = testing.fc;

const flush = async (rounds = 10): Promise<void> => {
	if (rounds <= 0) return;
	await Promise.resolve();
	return flush(rounds - 1);
};

const yield_times = async (k: number): Promise<void> => flush(k);

const items_arb = fc.array(fc.integer(), { maxLength: 40 });
const n_arb = fc.integer({ min: 1, max: 8 });
const yields_arb = fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 40 });

const yields_at = (yields: number[], index: number): number => yields[index % yields.length] ?? 1;

const transform = (x: number, index: number): number => x * 31 + index;

const run_options = { numRuns: 100 };

const by_index = (a: [number, number], b: [number, number]) => a[1] - b[1];

describe("Concurrency Utilities", () => {
	describe("Semaphore", () => {
		test("allows immediate acquire when permits available", async () => {
			const semaphore = new Semaphore(2);
			let acquired = 0;
			const pending = (async () => {
				await semaphore.acquire();
				acquired++;
				await semaphore.acquire();
				acquired++;
			})();

			await flush();
			expect(acquired).toBe(2);
			await pending;
		});

		test("blocks when no permits available", async () => {
			const semaphore = new Semaphore(1);
			await semaphore.acquire();

			let acquired = false;
			const pending = semaphore.acquire().then(() => {
				acquired = true;
			});

			await flush();
			expect(acquired).toBe(false);

			semaphore.release();
			await pending;
			expect(acquired).toBe(true);
		});

		test("release unblocks waiting acquire", async () => {
			const semaphore = new Semaphore(1);
			await semaphore.acquire();

			const order: number[] = [];

			const pending = semaphore.acquire().then(() => {
				order.push(2);
			});

			order.push(1);
			semaphore.release();
			await pending;
			order.push(3);

			expect(order).toEqual([1, 2, 3]);
		});

		test("multiple waiters are processed in order", async () => {
			const semaphore = new Semaphore(1);
			await semaphore.acquire();

			const order: number[] = [];

			const pending1 = semaphore.acquire().then(() => {
				order.push(1);
				semaphore.release();
			});

			const pending2 = semaphore.acquire().then(() => {
				order.push(2);
				semaphore.release();
			});

			const pending3 = semaphore.acquire().then(() => {
				order.push(3);
				semaphore.release();
			});

			semaphore.release();

			await Promise.all([pending1, pending2, pending3]);

			expect(order).toEqual([1, 2, 3]);
		});

		test("release increments permits when no waiters", async () => {
			const semaphore = new Semaphore(1);
			semaphore.release();

			let done = false;
			const pending = (async () => {
				await semaphore.acquire();
				await semaphore.acquire();
				done = true;
			})();

			await flush();
			expect(done).toBe(true);
			await pending;
		});

		test("release handing off to a waiter does not mint an extra permit", async () => {
			const semaphore = new Semaphore(1);
			await semaphore.acquire();

			const woken = semaphore.acquire();
			semaphore.release();
			await woken;

			let extra = false;
			const pending = semaphore.acquire().then(() => {
				extra = true;
			});

			await flush();
			expect(extra).toBe(false);

			semaphore.release();
			await pending;
		});

		test("works with zero initial permits", async () => {
			const semaphore = new Semaphore(0);

			let acquired = false;
			const pending = semaphore.acquire().then(() => {
				acquired = true;
			});

			await flush();
			expect(acquired).toBe(false);

			semaphore.release();
			await pending;
			expect(acquired).toBe(true);
		});
	});

	describe("parallel_map", () => {
		test("results equal items.map in order, whatever the completion order", async () => {
			await fc.assert(
				fc.asyncProperty(items_arb, n_arb, yields_arb, async (items, n, yields) => {
					const results = await parallel_map(
						items,
						async (x, i) => {
							await yield_times(yields_at(yields, i));
							return transform(x, i);
						},
						n,
					);
					expect(results).toEqual(items.map(transform));
				}),
				run_options,
			);
		});

		test("in-flight mappers never exceed concurrency, and reach min(n, len)", async () => {
			await fc.assert(
				fc.asyncProperty(items_arb, n_arb, yields_arb, async (items, n, yields) => {
					const state = { current: 0, max: 0 };
					await parallel_map(
						items,
						async (_, i) => {
							state.current++;
							state.max = Math.max(state.max, state.current);
							await yield_times(yields_at(yields, i));
							state.current--;
							return i;
						},
						n,
					);
					expect(state.max).toBe(Math.min(n, items.length));
					expect(state.current).toBe(0);
				}),
				run_options,
			);
		});

		test("mapper receives each item's position as index", async () => {
			await fc.assert(
				fc.asyncProperty(items_arb, n_arb, yields_arb, async (items, n, yields) => {
					const seen: Array<[number, number]> = [];
					await parallel_map(
						items,
						async (x, i) => {
							await yield_times(yields_at(yields, i));
							seen.push([x, i]);
							return i;
						},
						n,
					);
					const expected = items.map((x, i): [number, number] => [x, i]);
					expect(seen.toSorted(by_index)).toEqual(expected);
				}),
				run_options,
			);
		});

		test("a rejecting mapper rejects the whole map with its error", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(fc.integer(), { minLength: 1, maxLength: 40 }),
					n_arb,
					yields_arb,
					fc.nat(),
					async (items, n, yields, pick) => {
						const bad = pick % items.length;
						const failing = parallel_map(
							items,
							async (x, i) => {
								await yield_times(yields_at(yields, i));
								if (i === bad) throw new Error(`failed at ${String(bad)}`);
								return x;
							},
							n,
						);
						await expect(failing).rejects.toThrow(`failed at ${String(bad)}`);
					},
				),
				run_options,
			);
		});
	});
});
