import type { ZodSchema } from "zod";
import type { Codec } from "./types";

export function json_codec<T>(schema: ZodSchema<T>): Codec<T> {
	return {
		content_type: "application/json",
		encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
		decode: (bytes) => schema.parse(JSON.parse(new TextDecoder().decode(bytes))),
	};
}

export function text_codec(): Codec<string> {
	return {
		content_type: "text/plain",
		encode: (value) => new TextEncoder().encode(value),
		decode: (bytes) => new TextDecoder().decode(bytes),
	};
}

export function binary_codec(): Codec<Uint8Array> {
	return {
		content_type: "application/octet-stream",
		encode: (value) => value,
		decode: (bytes) => bytes,
	};
}
