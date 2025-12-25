/**
 * @module Result
 * @description Extended utilities for working with Result types.
 *
 * Provides functional utilities for error handling without exceptions:
 * - Pattern matching with `match`
 * - Safe unwrapping with `unwrap_or`, `unwrap`, `unwrap_err`
 * - Exception-to-Result conversion with `try_catch`, `try_catch_async`
 * - Fetch wrapper with `fetch_result`
 * - Composable pipelines with `pipe`
 */

import { ok, err, type Result } from "./types";

/**
 * Pattern match on a Result, extracting the value with appropriate handler.
 *
 * @param result - The Result to match on
 * @param on_ok - Handler for success case
 * @param on_err - Handler for error case
 * @returns The return value of the matching handler
 *
 * @example
 * ```ts
 * const result = await fetchUser(id)
 * const message = match(
 *   result,
 *   user => `Hello, ${user.name}!`,
 *   error => `Failed: ${error.message}`
 * )
 * ```
 */
export const match = <T, E, R>(result: Result<T, E>, on_ok: (value: T) => R, on_err: (error: E) => R): R => {
	if (result.ok) return on_ok(result.value);
	return on_err(result.error);
};

/**
 * Extract value from Result, returning default if error.
 *
 * @param result - The Result to unwrap
 * @param default_value - Value to return if Result is an error
 * @returns The success value or default
 *
 * @example
 * ```ts
 * const users = unwrap_or(await fetchUsers(), [])
 * ```
 */
export const unwrap_or = <T, E>(result: Result<T, E>, default_value: T): T => (result.ok ? result.value : default_value);

/**
 * Extract value from Result, throwing if error.
 * Use only when you're certain the Result is Ok, or in tests.
 *
 * @param result - The Result to unwrap
 * @returns The success value
 * @throws Error if Result is an error
 *
 * @example
 * ```ts
 * // In tests
 * const user = unwrap(await createUser(data))
 * expect(user.name).toBe('Alice')
 * ```
 */
export const unwrap = <T, E>(result: Result<T, E>): T => {
	if (!result.ok) throw new Error(`unwrap called on error result: ${JSON.stringify(result.error)}`);
	return result.value;
};

/**
 * Extract error from Result, throwing if Ok.
 * Use only when you're certain the Result is Err, or in tests.
 *
 * @param result - The Result to unwrap
 * @returns The error value
 * @throws Error if Result is Ok
 *
 * @example
 * ```ts
 * // In tests
 * const error = unwrap_err(await createUser(invalidData))
 * expect(error.kind).toBe('validation_error')
 * ```
 */
export const unwrap_err = <T, E>(result: Result<T, E>): E => {
	if (result.ok) throw new Error(`unwrap_err called on ok result: ${JSON.stringify(result.value)}`);
	return result.error;
};

/**
 * Execute a function and convert exceptions to Result.
 *
 * @param fn - Function to execute
 * @param on_error - Transform caught exception to error type
 * @returns Result containing success value or transformed error
 *
 * @example
 * ```ts
 * const result = try_catch(
 *   () => JSON.parse(input),
 *   e => ({ kind: 'parse_error', message: format_error(e) })
 * )
 * ```
 */
export const try_catch = <T, E>(fn: () => T, on_error: (e: unknown) => E): Result<T, E> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(on_error(e));
	}
};

/**
 * Execute an async function and convert exceptions to Result.
 *
 * @param fn - Async function to execute
 * @param on_error - Transform caught exception to error type
 * @returns Promise of Result containing success value or transformed error
 *
 * @example
 * ```ts
 * const result = await try_catch_async(
 *   () => db.query('SELECT * FROM users'),
 *   e => ({ kind: 'database_error', cause: e })
 * )
 * ```
 */
export const try_catch_async = async <T, E>(fn: () => Promise<T>, on_error: (e: unknown) => E): Promise<Result<T, E>> => {
	try {
		return ok(await fn());
	} catch (e) {
		return err(on_error(e));
	}
};

/**
 * Error types for fetch operations.
 */
export type FetchError = { type: "network"; cause: unknown } | { type: "http"; status: number; status_text: string };

/**
 * Fetch wrapper that returns Result instead of throwing.
 *
 * @param input - URL or Request to fetch
 * @param init - Fetch options
 * @param on_error - Transform FetchError to your error type
 * @param parse_body - Custom body parser (defaults to JSON)
 * @returns Promise of Result with parsed response or error
 *
 * @example
 * ```ts
 * const result = await fetch_result(
 *   'https://api.example.com/users',
 *   { headers: { Authorization: `Bearer ${token}` } },
 *   e => e.type === 'http' ? `HTTP ${e.status}` : 'Network error'
 * )
 * ```
 */
export const fetch_result = async <T, E>(input: string | URL | Request, init: RequestInit | undefined, on_error: (e: FetchError) => E, parse_body: (response: Response) => Promise<T> = r => r.json() as Promise<T>): Promise<Result<T, E>> => {
	try {
		const response = await fetch(input, init);
		if (!response.ok) {
			return err(on_error({ type: "http", status: response.status, status_text: response.statusText }));
		}
		return ok(await parse_body(response));
	} catch (e) {
		return err(on_error({ type: "network", cause: e }));
	}
};

type MaybePromise<T> = T | Promise<T>;

/**
 * A composable pipeline for chaining Result operations.
 *
 * All operations are lazy - nothing executes until `.result()` or `.unwrap_or()` is called.
 *
 * @example
 * ```ts
 * const user = await pipe(fetchUser(id))
 *   .map(user => user.profile)
 *   .flat_map(profile => fetchAvatar(profile.avatar_id))
 *   .map(avatar => avatar.url)
 *   .unwrap_or('/default-avatar.png')
 * ```
 */
export type Pipe<T, E> = {
	/** Transform the success value */
	map: <U>(fn: (value: T) => U) => Pipe<U, E>;
	/** Transform the success value with an async function */
	map_async: <U>(fn: (value: T) => Promise<U>) => Pipe<U, E>;
	/** Chain with another Result-returning operation */
	flat_map: <U>(fn: (value: T) => MaybePromise<Result<U, E>>) => Pipe<U, E>;
	/** Transform the error value */
	map_err: <F>(fn: (error: E) => F) => Pipe<T, F>;
	/** Execute side effect on success (logging, metrics) */
	tap: (fn: (value: T) => MaybePromise<void>) => Pipe<T, E>;
	/** Execute side effect on error */
	tap_err: (fn: (error: E) => MaybePromise<void>) => Pipe<T, E>;
	/** Extract value with fallback */
	unwrap_or: (default_value: T) => Promise<T>;
	/** Get the underlying Result */
	result: () => Promise<Result<T, E>>;
};

const create_pipe = <T, E>(promised: Promise<Result<T, E>>): Pipe<T, E> => ({
	map: <U>(fn: (value: T) => U): Pipe<U, E> =>
		create_pipe(
			promised.then((r): Result<U, E> => {
				if (r.ok) return ok(fn(r.value));
				return err(r.error);
			})
		),
	map_async: <U>(fn: (value: T) => Promise<U>): Pipe<U, E> =>
		create_pipe(
			promised.then(async (r): Promise<Result<U, E>> => {
				if (r.ok) return ok(await fn(r.value));
				return err(r.error);
			})
		),
	flat_map: <U>(fn: (value: T) => MaybePromise<Result<U, E>>): Pipe<U, E> =>
		create_pipe(
			promised.then((r): MaybePromise<Result<U, E>> => {
				if (r.ok) return fn(r.value);
				return err(r.error);
			})
		),
	map_err: <F>(fn: (error: E) => F): Pipe<T, F> =>
		create_pipe(
			promised.then((r): Result<T, F> => {
				if (r.ok) return ok(r.value);
				return err(fn(r.error));
			})
		),
	tap: (fn: (value: T) => MaybePromise<void>): Pipe<T, E> =>
		create_pipe(
			promised.then(async (r): Promise<Result<T, E>> => {
				if (r.ok) await fn(r.value);
				return r;
			})
		),
	tap_err: (fn: (error: E) => MaybePromise<void>): Pipe<T, E> =>
		create_pipe(
			promised.then(async (r): Promise<Result<T, E>> => {
				if (!r.ok) await fn(r.error);
				return r;
			})
		),
	unwrap_or: (default_value: T): Promise<T> => promised.then(r => (r.ok ? r.value : default_value)),
	result: (): Promise<Result<T, E>> => promised,
});

/**
 * Create a composable pipeline from a Result or Promise<Result>.
 *
 * @param initial - Starting Result value (sync or async)
 * @returns A Pipe for chaining operations
 *
 * @example
 * ```ts
 * // From existing Result
 * const result = await pipe(ok(42))
 *   .map(n => n * 2)
 *   .result()
 *
 * // From async operation
 * const user = await pipe(fetchUser(id))
 *   .flat_map(u => fetchProfile(u.id))
 *   .result()
 * ```
 */
export const pipe = <T, E>(initial: MaybePromise<Result<T, E>>): Pipe<T, E> => create_pipe(Promise.resolve(initial));

/** Create a pipe starting with an Ok value */
pipe.ok = <T>(value: T): Pipe<T, never> => pipe(ok(value));

/** Create a pipe starting with an Err value */
pipe.err = <E>(error: E): Pipe<never, E> => pipe(err(error));

/** Create a pipe from a function that may throw */
pipe.try = <T, E>(fn: () => Promise<T>, on_error: (e: unknown) => E): Pipe<T, E> => pipe(try_catch_async(fn, on_error));

/** Create a pipe from a fetch operation */
pipe.fetch = <T, E>(input: string | URL | Request, init: RequestInit | undefined, on_error: (e: FetchError) => E, parse_body?: (response: Response) => Promise<T>): Pipe<T, E> => pipe(fetch_result(input, init, on_error, parse_body));

/**
 * Extract value from Result, returning null for any error.
 * Use for "fetch single resource" patterns where not-found is expected.
 *
 * @param result - The Result to convert
 * @returns The value or null
 *
 * @example
 * ```ts
 * const user = to_nullable(await store.get(userId))
 * if (!user) return <NotFound />
 * ```
 */
export const to_nullable = <T, E>(result: Result<T, E>): T | null => (result.ok ? result.value : null);

/**
 * Extract value from Result, returning fallback for any error.
 * Use for list endpoints where empty array is acceptable.
 *
 * @param result - The Result to convert
 * @param fallback - Value to return on error
 * @returns The value or fallback
 *
 * @example
 * ```ts
 * const items = to_fallback(await store.list(), [])
 * ```
 */
export const to_fallback = <T, E>(result: Result<T, E>, fallback: T): T => (result.ok ? result.value : fallback);

/**
 * Return null if error matches predicate, otherwise throw the error.
 * Use for 404-as-null pattern specifically.
 *
 * @param result - The Result to check
 * @param predicate - Returns true for expected errors (e.g., not_found)
 * @returns The value or null for expected errors
 * @throws The error if predicate returns false
 *
 * @example
 * ```ts
 * const user = null_on(
 *   await store.get(id),
 *   e => e.kind === 'not_found'
 * )
 * ```
 */
export const null_on = <T, E>(result: Result<T, E>, predicate: (error: E) => boolean): T | null => {
	if (result.ok) return result.value;
	if (predicate(result.error)) return null;
	throw result.error;
};

/**
 * Return fallback if error matches predicate, otherwise throw.
 *
 * @param result - The Result to check
 * @param predicate - Returns true for expected errors
 * @param fallback - Value to return for expected errors
 * @returns The value or fallback for expected errors
 * @throws The error if predicate returns false
 *
 * @example
 * ```ts
 * const count = fallback_on(
 *   await store.count(),
 *   e => e.kind === 'not_found',
 *   0
 * )
 * ```
 */
export const fallback_on = <T, E>(result: Result<T, E>, predicate: (error: E) => boolean, fallback: T): T => {
	if (result.ok) return result.value;
	if (predicate(result.error)) return fallback;
	throw result.error;
};

/**
 * Format an unknown error to a string message.
 *
 * @param e - Any error value
 * @returns A string representation
 *
 * @example
 * ```ts
 * try {
 *   riskyOperation()
 * } catch (e) {
 *   console.error(format_error(e)) // Handles Error, string, or anything
 * }
 * ```
 */
export const format_error = (e: unknown): string => (e instanceof Error ? e.message : String(e));
