/**
 * @module Concurrency
 * @description Utilities for controlling concurrent async operations.
 */

/**
 * Semaphore for controlling concurrent operations.
 *
 * Limits the number of concurrent async operations by requiring
 * callers to acquire a permit before proceeding. When all permits
 * are taken, subsequent acquires wait until a permit is released.
 *
 * @example
 * ```ts
 * const semaphore = new Semaphore(3) // Allow 3 concurrent operations
 *
 * async function rateLimitedFetch(url: string) {
 *   await semaphore.acquire()
 *   try {
 *     return await fetch(url)
 *   } finally {
 *     semaphore.release()
 *   }
 * }
 *
 * // Only 3 fetches will run concurrently
 * await Promise.all(urls.map(rateLimitedFetch))
 * ```
 */
export class Semaphore {
	private permits: number;
	private waiting: Array<() => void> = [];

	constructor(permits: number) {
		this.permits = permits;
	}

	/**
	 * Acquire a permit. Resolves immediately if available,
	 * otherwise waits until a permit is released.
	 */
	async acquire(): Promise<void> {
		if (this.permits > 0) {
			this.permits--;
			return;
		}
		return new Promise<void>(resolve => {
			this.waiting.push(resolve);
		});
	}

	/**
	 * Release a permit, allowing the next waiting operation to proceed.
	 */
	release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
		} else {
			this.permits++;
		}
	}
}

/**
 * Map over array with controlled concurrency.
 *
 * Unlike Promise.all which starts all operations at once, this limits
 * concurrent operations. Results are returned in the same order as inputs.
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent operations
 * @returns Array of results in the same order as inputs
 *
 * @example
 * ```ts
 * // Process 100 items, but only 5 at a time
 * const results = await parallel_map(
 *   urls,
 *   async (url, index) => {
 *     console.log(`Fetching ${index + 1}/${urls.length}`)
 *     return fetch(url).then(r => r.json())
 *   },
 *   5
 * )
 * ```
 *
 * @example
 * ```ts
 * // Use with AI APIs that have rate limits
 * const summaries = await parallel_map(
 *   documents,
 *   doc => summarize(doc),
 *   3 // Only 3 concurrent API calls
 * )
 * ```
 */
export const parallel_map = async <T, R>(items: T[], mapper: (item: T, index: number) => Promise<R>, concurrency: number): Promise<R[]> => {
	const semaphore = new Semaphore(concurrency);
	const results: R[] = new Array(items.length);

	await Promise.all(
		items.map(async (item, index) => {
			await semaphore.acquire();
			try {
				results[index] = await mapper(item, index);
			} finally {
				semaphore.release();
			}
		})
	);

	return results;
};
