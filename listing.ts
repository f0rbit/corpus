import type { CorpusError, CorpusEvent, EventHandler, Result } from "./types.js";
import { err, ok } from "./types.js";

/**
 * Backends report listing failures (`list`, `list_stores`) as an `error`
 * event and then end the AsyncIterable — the signature has no error channel.
 * An `ErrorTracker` records those events so `collect_listing` can turn them
 * back into a failing Result instead of a silently empty listing.
 * @category Core
 * @group Listing
 */
export type ErrorTracker = {
	errors: CorpusError[];
};

/**
 * Build an `on_event` handler that records every `error` event into a tracker,
 * forwarding each event to `on_event` when one is given.
 * @category Core
 * @group Listing
 *
 * @example
 * ```ts
 * const { on_event, tracker } = with_error_tracking()
 * const backend = create_cloudflare_backend({ d1, r2, on_event })
 * const stores = await collect_listing(tracker, backend.metadata.list_stores!())
 * ```
 */
export function with_error_tracking(on_event?: EventHandler): { on_event: EventHandler; tracker: ErrorTracker } {
	const errors: CorpusError[] = [];
	return {
		tracker: { errors },
		on_event: (event: CorpusEvent) => {
			if (event.type === "error") errors.push(event.error);
			on_event?.(event);
		},
	};
}

/**
 * Collect an async listing, failing with the first error the tracker recorded
 * while iterating. With no tracker this is plain collection.
 * @category Core
 * @group Listing
 */
export async function collect_listing<T>(
	tracker: ErrorTracker | undefined,
	items: AsyncIterable<T>,
): Promise<Result<T[], CorpusError>> {
	const seen = tracker?.errors.length ?? 0;

	const collected: T[] = [];
	for await (const item of items) collected.push(item);

	const failure = tracker?.errors.slice(seen)[0];
	return failure ? err(failure) : ok(collected);
}
