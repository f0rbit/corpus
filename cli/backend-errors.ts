import type { Backend, CorpusError, CorpusEvent, EventHandler, Result } from "../types.js";
import { err, ok } from "../types.js";

// Backends report listing failures (`list`, `list_stores`) as an `error`
// event and then end the AsyncIterable — the signature has no error channel.
// The CLI records those events per backend and turns them back into a failing
// Result via `collect_list`, so a bad token never masquerades as an empty db.
export type ErrorSink = {
	on_event: EventHandler;
	errors: CorpusError[];
};

const sinks = new WeakMap<Backend, ErrorSink>();

export function create_error_sink(): ErrorSink {
	const errors: CorpusError[] = [];
	return {
		errors,
		on_event: (event: CorpusEvent) => {
			if (event.type === "error") errors.push(event.error);
		},
	};
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

export async function collect_list<T>(backend: Backend, items: AsyncIterable<T>): Promise<Result<T[], CorpusError>> {
	const sink = sinks.get(backend);
	const seen = sink?.errors.length ?? 0;

	const collected: T[] = [];
	for await (const item of items) collected.push(item);

	const failure = sink?.errors.slice(seen)[0];
	return failure ? err(failure) : ok(collected);
}
