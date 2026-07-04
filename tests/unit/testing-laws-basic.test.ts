/**
 * Unit tests for testing.law.round_trip and testing.law.idempotent.
 * Basic coverage: JSON round-trip, string trimming, and error messages.
 */

import { test } from "bun:test";
import { testing } from "../../index.js";

/**
 * JSON encode/decode pair for testing round_trip.
 */
const json_codec = {
	encode: (x: unknown) => new TextEncoder().encode(JSON.stringify(x)),
	decode: (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)),
};

test("round_trip: JSON string", async () => {
	await testing.law.round_trip(testing.fc.string(), json_codec.encode, json_codec.decode);
});

test("round_trip: JSON number", async () => {
	await testing.law.round_trip(testing.fc.integer(), json_codec.encode, json_codec.decode);
});

const trim_op = (s: string) => s.trim();
const custom_equals = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const broken_encode = (_x: string) => new Uint8Array([0, 1, 2]); // Always returns same bytes
const broken_decode = () => "always_same";

test("round_trip: JSON object", async () => {
	const arb = testing.fc.record({
		name: testing.fc.string(),
		age: testing.fc.integer({ min: 0, max: 150 }),
	});
	await testing.law.round_trip(arb, json_codec.encode, json_codec.decode);
});

test("idempotent: string trim", async () => {
	await testing.law.idempotent(testing.fc.string(), trim_op);
});

test("round_trip: JSON with custom equals", async () => {
	await testing.law.round_trip(
		testing.fc.object({ withMap: false, withSet: false, maxDepth: 2 }),
		json_codec.encode,
		json_codec.decode,
		{ equals: custom_equals, numRuns: 50 },
	);
});

test("round_trip: broken encoder surfaces actionable error", async () => {
	let error_thrown = false;
	let error_message = "";

	try {
		await testing.law.round_trip(testing.fc.string({ minLength: 1 }), broken_encode, broken_decode, {
			numRuns: 10,
		});
	} catch (e) {
		error_thrown = true;
		if (e instanceof Error) {
			error_message = e.message;
		}
	}

	if (!error_thrown) {
		throw new Error("Expected round_trip to throw on broken encode/decode");
	}

	// Verify the error is actionable — fast-check includes a counterexample showing the failing input
	if (!error_message.includes("Property failed") && !error_message.includes("Counterexample")) {
		throw new Error(`Error should indicate property failure, got: ${error_message}`);
	}
});
