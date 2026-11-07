import { describe, it, expect } from "bun:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { create_cloudflare_backend } from "../../backend/cloudflare.js";

// Compile-time regression (issue #57 item 9): real Workers bindings must be accepted by
// create_cloudflare_backend. The check is `bun run typecheck`; the function is never called.
// Imported as types from the module entrypoint, so workers-types' globals never leak into the suite.
function accepts_real_bindings(d1: D1Database, r2: R2Bucket) {
	return create_cloudflare_backend({ d1, r2 });
}

describe("cloudflare backend binding types", () => {
	it("accepts real D1Database / R2Bucket bindings (checked by tsc)", () => {
		expect(typeof accepts_real_bindings).toBe("function");
	});
});
