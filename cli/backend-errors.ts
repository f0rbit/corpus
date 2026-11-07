import { collect_listing, with_error_tracking, type ErrorTracker } from "../listing.js";
import type { Backend, CorpusError, EventHandler, Result } from "../types.js";

// The CLI records listing failures per backend (see `listing.ts`) and turns
// them back into a failing Result via `collect_list`, so a bad token never
// masquerades as an empty db.
export type ErrorSink = ErrorTracker & {
	on_event: EventHandler;
};

const sinks = new WeakMap<Backend, ErrorSink>();

export function create_error_sink(): ErrorSink {
	const { on_event, tracker } = with_error_tracking();
	return { ...tracker, on_event };
}

export function track_errors(backend: Backend, sink: ErrorSink): Backend {
	sinks.set(backend, sink);
	return backend;
}

// Errors recorded since `since` (an earlier `recorded_count`) — for callers that
// can't route iteration through `collect_list` (e.g. the library `copy()`).
export function recorded_count(backend: Backend): number {
	return sinks.get(backend)?.errors.length ?? 0;
}

export function errors_since(backend: Backend, since: number): CorpusError | undefined {
	return sinks.get(backend)?.errors.slice(since)[0];
}

export function collect_list<T>(backend: Backend, items: AsyncIterable<T>): Promise<Result<T[], CorpusError>> {
	return collect_listing(sinks.get(backend), items);
}
