import type { Codec } from "./types";

// Use a structural type that matches both Zod 3.x and 4.x
type ZodLike<T> = { parse: (data: unknown) => T };

export function json_codec<T>(schema: ZodLike<T>): Codec<T> {
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
