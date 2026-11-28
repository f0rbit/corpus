/**
 * Error paths of the remote adapters (`backend/remote-d1.ts`, `backend/remote-r2.ts`),
 * driven through `create_remote_backend` against the HTTP fakes' `set_responder` hook.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { create_remote_backend } from "../../backend/remote.js";
import type { CorpusEvent } from "../../types.js";
import { corpus_observations } from "../../observations/schema.js";
import { corpus_snapshots } from "../../schema.js";
import { create_fake_d1_http, type FakeD1HttpServer } from "../fakes/d1-http.js";
import { create_fake_s3, type FakeS3Server } from "../fakes/s3.js";

const api_token = "tok-secret-7f3a91";

// [name, response, fragment of the adapter message]: asserting the fragment pins WHICH check rejected it
// drizzle wraps the adapter's throw ("Failed query: ..."); the original message sits down the cause chain
const chain_text = (error: Error): string => {
	const messages: string[] = [];
	for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message);
	return messages.join(" | ");
};

const d1_cases: ReadonlyArray<readonly [string, () => Response, string]> = [
	["non-2xx", () => new Response("boom", { status: 500 }), "D1 HTTP error 500"],
	[
		"non-2xx with a D1 envelope",
		() =>
			Response.json(
				{ success: false, errors: [{ code: 7500, message: "near x: syntax error" }], result: [] },
				{ status: 400 },
			),
		"D1 HTTP error 400: near x: syntax error",
	],
	["non-JSON 200", () => new Response("not json", { status: 200 }), "Failed to parse D1 HTTP response"],
	["wrong shape", () => Response.json({ hello: 1 }), "Invalid D1 HTTP response structure"],
	[
		"success:false",
		() => Response.json({ success: false, errors: [{ code: 7500, message: "x" }], result: [] }),
		"D1 SQL error: x",
	],
	["empty result", () => Response.json({ success: true, errors: [], result: [] }), "D1 HTTP response missing result"],
	[
		"statement failed",
		() => Response.json({ success: true, errors: [], result: [{ success: false, error: "bad" }] }),
		"D1 statement failed: bad",
	],
];

describe("remote adapters — error paths", () => {
	let d1: FakeD1HttpServer;
	let s3: FakeS3Server;
	let events: CorpusEvent[];

	beforeAll(() => {
		d1 = create_fake_d1_http([corpus_snapshots, corpus_observations]);
		s3 = create_fake_s3();
	});

	afterAll(() => {
		d1.stop();
		s3.stop();
	});

	beforeEach(() => {
		d1.reset();
		s3.reset();
		events = [];
	});

	const make_backend = (d1_base_url: string = d1.url) =>
		create_remote_backend({
			account_id: "acct",
			database_id: "db",
			api_token,
			d1_base_url,
			r2: { bucket: "b", access_key_id: "ak", secret_access_key: "sk", endpoint: s3.url },
			on_event: (event) => {
				events.push(event);
			},
		});

	const expect_storage_error = async (fragment: string, d1_base_url?: string) => {
		const result = await make_backend(d1_base_url).metadata.get("s1", "v1");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("storage_error");
		if (result.error.kind !== "storage_error") return;
		expect(result.error.operation).toBe("metadata.get");
		const text = chain_text(result.error.cause);
		expect(text).toContain(fragment);
		expect(text).not.toContain(api_token);
		expect(events.some((event) => event.type === "error")).toBe(true);
		expect(JSON.stringify(events)).not.toContain(api_token);
	};

	describe("D1 envelopes", () => {
		it("network failure maps to storage_error", async () => {
			const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
			const dead_url = `http://localhost:${String(dead.port)}`;
			await dead.stop(true);
			await expect_storage_error("D1 HTTP request failed", dead_url);
		});

		it.each(d1_cases)("%s maps to storage_error", async (_name, respond, fragment) => {
			d1.set_responder(respond);
			await expect_storage_error(fragment);
		});

		it("a result without `results` is an ok write", async () => {
			d1.set_responder(() => Response.json({ success: true, errors: [], result: [{ success: true }] }));
			const result = await make_backend().metadata.delete("s1", "v1");
			expect(result.ok).toBe(true);
			expect(events.some((event) => event.type === "error")).toBe(false);
		});

		it("get with zero rows is not_found, not a storage error", async () => {
			const result = await make_backend().metadata.get("s1", "missing");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("not_found");
		});
	});

	describe("R2 probe failures", () => {
		const fail_head_and_delete = (): void => {
			s3.set_responder((request) =>
				request.method === "HEAD" || request.method === "DELETE" ? new Response("", { status: 500 }) : undefined,
			);
		};

		it("exists is false when the probe errors", async () => {
			const backend = make_backend();
			const put = await backend.data.put("k", new Uint8Array([1, 2, 3]));
			expect(put.ok).toBe(true);
			expect(await backend.data.exists("k")).toBe(true);

			fail_head_and_delete();
			expect(await backend.data.exists("k")).toBe(false);
			expect(events.some((e) => e.type === "error" && e.error.kind === "storage_error")).toBe(true);
		});

		// a failed probe (auth/5xx) is a storage error, never a miss
		it.each([403, 500])("get is storage_error when the exists probe fails with %d", async (status) => {
			const backend = make_backend();
			await backend.data.put("k", new Uint8Array([1, 2, 3]));

			s3.set_responder((request) => (request.method === "HEAD" ? new Response("", { status }) : undefined));
			const result = await backend.data.get("k");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe("storage_error");
			if (result.error.kind !== "storage_error") return;
			expect(result.error.operation).toBe("data.get");
		});

		it("get of a genuinely missing key is not_found naming the store prefix and key", async () => {
			const result = await make_backend().data.get("hansard/raw/v1");
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error).toEqual({
				kind: "not_found",
				store_id: "hansard",
				version: "hansard/raw/v1",
				message: "data object missing",
			});
		});

		it("empty credentials fail every data op loudly without contacting R2", async () => {
			const backend = create_remote_backend({
				account_id: "acct",
				database_id: "db",
				api_token,
				d1_base_url: d1.url,
				r2: { bucket: "b", access_key_id: "", secret_access_key: "", endpoint: s3.url },
			});
			const seen: string[] = [];
			s3.set_responder((request) => {
				seen.push(request.method);
				return undefined;
			});
			const got = await backend.data.get("k");
			const put = await backend.data.put("k", new Uint8Array([1]));
			expect(await backend.data.exists("k")).toBe(false);
			for (const result of [got, put]) {
				expect(result.ok).toBe(false);
				if (result.ok || result.error.kind !== "storage_error") throw new Error("expected storage_error");
				expect(result.error.cause.message).toContain("R2 credentials missing");
			}
			expect(seen).toEqual([]);
		});

		it("delete swallows errors", async () => {
			const backend = make_backend();
			await backend.data.put("k", new Uint8Array([1, 2, 3]));

			fail_head_and_delete();
			const result = await backend.data.delete("k");
			expect(result.ok).toBe(true);
			expect(s3.has("k")).toBe(true);
		});
	});
});
