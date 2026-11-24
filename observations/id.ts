/**
 * @file id.ts
 * @description Internal helpers for caller-supplied observation ids (not part of the public barrel).
 */

import type { Result, CorpusError } from "../types.js";
import { ok, err } from "../types.js";
import { as_error } from "../utils.js";
import { generate_observation_id, observation_id_schema } from "./utils.js";

/**
 * Resolves the id for a put: the caller's id if valid, else a generated one.
 */
export function resolve_observation_id(id?: string): Result<string, CorpusError> {
	if (id === undefined) return ok(generate_observation_id());
	const parsed = observation_id_schema.safeParse(id);
	if (parsed.success) return ok(id);
	return err({
		kind: "validation_error",
		message: `invalid observation id "${id}"`,
		cause: as_error(parsed.error),
	});
}

/**
 * The error returned when a put reuses an existing observation id.
 */
export function observation_id_collision(id: string): CorpusError {
	const cause = observation_id_collision_cause(id);
	return { kind: "validation_error", message: cause.message, cause };
}

/**
 * Same collision as an `Error`, for backends that abort a batch by throwing.
 */
export function observation_id_collision_cause(id: string): Error {
	return new Error(`observation id "${id}" already exists`);
}
