import { describe, test, expect } from "bun:test";
import { Semaphore, parallel_map } from "../../concurrency";

describe("Concurrency Utilities", () => {
	describe("Semaphore", () => {
		test("allows immediate acquire when permits available", async () => {
			const semaphore = new Semaphore(2);
			await semaphore.acquire();
			await semaphore.acquire();
			expect(true).toBe(true);
		});

		test("blocks when no permits available", async () => {
			const semaphore = new Semaphore(1);
			await semaphore.acquire();

			let acquired = false;
			const pending = semaphore.acquire().then(() => {
				acquired = true;
			});

			await new Promise(r => setTimeout(r, 10));
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

			let blocked = false;
			await Promise.race([
				(async () => {
					await semaphore.acquire();
					await semaphore.acquire();
				})(),
				new Promise(r => setTimeout(r, 10)).then(() => {
					blocked = true;
				}),
			]);
			expect(blocked).toBe(false);
		});

		test("works with zero initial permits", async () => {
			const semaphore = new Semaphore(0);

			let acquired = false;
			const pending = semaphore.acquire().then(() => {
				acquired = true;
			});

			await new Promise(r => setTimeout(r, 10));
			expect(acquired).toBe(false);

			semaphore.release();
			await pending;
			expect(acquired).toBe(true);
		});

		test("handles high concurrency", async () => {
			const semaphore = new Semaphore(3);
			const concurrent: number[] = [];
			let maxConcurrent = 0;

			const tasks = Array.from({ length: 10 }, async (_, i) => {
				await semaphore.acquire();
				concurrent.push(i);
				maxConcurrent = Math.max(maxConcurrent, concurrent.length);
				await new Promise(r => setTimeout(r, 5));
				concurrent.splice(concurrent.indexOf(i), 1);
				semaphore.release();
			});

			await Promise.all(tasks);
			expect(maxConcurrent).toBeLessThanOrEqual(3);
		});
	});

	describe("parallel_map", () => {
		test("processes all items", async () => {
			const items = [1, 2, 3, 4, 5];
			const results = await parallel_map(items, async x => x * 2, 2);
			expect(results).toEqual([2, 4, 6, 8, 10]);
		});

		test("respects concurrency limit", async () => {
			const concurrent: number[] = [];
			let maxConcurrent = 0;

			const items = Array.from({ length: 10 }, (_, i) => i);
			await parallel_map(
				items,
				async (x, index) => {
					concurrent.push(index);
					maxConcurrent = Math.max(maxConcurrent, concurrent.length);
					await new Promise(r => setTimeout(r, 10));
					concurrent.splice(concurrent.indexOf(index), 1);
					return x * 2;
				},
				3
			);

			expect(maxConcurrent).toBeLessThanOrEqual(3);
		});

		test("returns results in original order", async () => {
			const items = [5, 1, 3, 2, 4];
			const results = await parallel_map(
				items,
				async x => {
					await new Promise(r => setTimeout(r, x * 5));
					return x * 10;
				},
				2
			);
			expect(results).toEqual([50, 10, 30, 20, 40]);
		});

		test("handles errors in individual mappers", async () => {
			const items = [1, 2, 3];

			await expect(
				parallel_map(
					items,
					async x => {
						if (x === 2) throw new Error("failed on 2");
						return x;
					},
					2
				)
			).rejects.toThrow("failed on 2");
		});

		test("works with empty array", async () => {
			const results = await parallel_map([] as number[], async x => x * 2, 3);
			expect(results).toEqual([]);
		});

		test("works with single item", async () => {
			const results = await parallel_map([42], async x => x * 2, 5);
			expect(results).toEqual([84]);
		});

		test("works when concurrency exceeds items", async () => {
			const items = [1, 2];
			const results = await parallel_map(items, async x => x * 2, 10);
			expect(results).toEqual([2, 4]);
		});

		test("passes index to mapper function", async () => {
			const items = ["a", "b", "c"];
			const results = await parallel_map(items, async (item, index) => `${item}-${index}`, 2);
			expect(results).toEqual(["a-0", "b-1", "c-2"]);
		});

		test("handles async operations with varying durations", async () => {
			const items = [100, 50, 10, 80, 30];
			const startTimes: number[] = [];
			const start = Date.now();

			await parallel_map(
				items,
				async delay => {
					startTimes.push(Date.now() - start);
					await new Promise(r => setTimeout(r, delay));
					return delay;
				},
				2
			);

			expect(startTimes[0]).toBeLessThan(20);
			expect(startTimes[1]).toBeLessThan(20);
			expect(startTimes[2]).toBeGreaterThan(40);
		});

		test("works with concurrency of 1 (sequential)", async () => {
			const order: number[] = [];
			const items = [1, 2, 3];

			await parallel_map(
				items,
				async x => {
					order.push(x);
					await new Promise(r => setTimeout(r, 10));
					return x;
				},
				1
			);

			expect(order).toEqual([1, 2, 3]);
		});

		test("handles objects as items", async () => {
			const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
			const results = await parallel_map(items, async item => ({ ...item, processed: true }), 2);
			expect(results).toEqual([
				{ id: 1, processed: true },
				{ id: 2, processed: true },
				{ id: 3, processed: true },
			]);
		});
	});
});
