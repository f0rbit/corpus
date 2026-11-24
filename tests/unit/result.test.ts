import { describe, test, expect, afterEach } from "bun:test";
import { unwrap, unwrap_err, fetch_result, type FetchError, pipe } from "../../result.js";
import { ok, err } from "../../types.js";

const mock_fetch = (fn: () => Promise<Response>): void => {
	globalThis.fetch = fn as unknown as typeof fetch;
};

describe("Result Utilities", () => {
	describe("unwrap", () => {
		test("throws for error result", () => {
			const result = err("something failed");
			expect(() => unwrap(result)).toThrow("unwrap called on error result");
		});

		test("includes error in thrown message", () => {
			const result = err({ code: 500, message: "Internal error" });
			expect(() => unwrap(result)).toThrow('"code":500');
		});
	});

	describe("unwrap_err", () => {
		test("throws for ok result", () => {
			const result = ok("success");
			expect(() => unwrap_err(result)).toThrow("unwrap_err called on ok result");
		});

		test("includes value in thrown message", () => {
			const result = ok({ name: "Alice" });
			expect(() => unwrap_err(result)).toThrow('"name":"Alice"');
		});
	});

	describe("fetch_result", () => {
		const original_fetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = original_fetch;
		});

		test("returns ok for successful fetch with JSON", async () => {
			mock_fetch(() => Promise.resolve(new Response(JSON.stringify({ data: "test" }), { status: 200 })));

			const result = await fetch_result("https://api.example.com/data", undefined, (e) => e);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({ data: "test" });
			}
		});

		test("returns HTTP error for non-ok response", async () => {
			mock_fetch(() => Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })));

			const result = await fetch_result<unknown, FetchError>("https://api.example.com/missing", undefined, (e) => e);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.type).toBe("http");
				if (result.error.type === "http") {
					expect(result.error.status).toBe(404);
					expect(result.error.status_text).toBe("Not Found");
				}
			}
		});

		test("returns network error for fetch failure", async () => {
			mock_fetch(() => Promise.reject(new Error("Network failure")));

			const result = await fetch_result<unknown, FetchError>("https://api.example.com/data", undefined, (e) => e);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.type).toBe("network");
			}
		});

		test("returns parse error when JSON parsing fails", async () => {
			mock_fetch(() => Promise.resolve(new Response("not json", { status: 200 })));

			const result = await fetch_result<unknown, string>("https://api.example.com/data", undefined, (e) =>
				e.type === "network" ? "parse failed" : "http error",
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("parse failed");
			}
		});

		test("uses custom error mapper", async () => {
			mock_fetch(() => Promise.resolve(new Response("", { status: 500, statusText: "Server Error" })));

			const result = await fetch_result<unknown, string>("https://api.example.com/data", undefined, (e) =>
				e.type === "http" ? `HTTP ${String(e.status)}` : "Network error",
			);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("HTTP 500");
			}
		});

		test("uses custom body parser", async () => {
			mock_fetch(() => Promise.resolve(new Response("plain text response", { status: 200 })));

			const result = await fetch_result<string, FetchError>(
				"https://api.example.com/text",
				undefined,
				(e) => e,
				(response) => response.text(),
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe("plain text response");
			}
		});

		test("passes request init options", async () => {
			let captured_init: RequestInit | undefined;
			const fake_fetch = (_input: string | Request | URL, init?: RequestInit) => {
				captured_init = init;
				return Promise.resolve(new Response("{}", { status: 200 }));
			};
			globalThis.fetch = fake_fetch as unknown as typeof fetch;

			await fetch_result(
				"https://api.example.com/data",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: "value" }),
				},
				(e) => e,
			);

			expect(captured_init?.method).toBe("POST");
			expect(captured_init?.headers).toEqual({ "Content-Type": "application/json" });
		});
	});

	describe("pipe", () => {
		const original_fetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = original_fetch;
		});

		test("pipe.fetch wraps fetch operation", async () => {
			mock_fetch(() => Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 })));

			const result = await pipe
				.fetch<{ id: number }, string>("https://api.example.com/item", undefined, (e) =>
					e.type === "http" ? `HTTP ${String(e.status)}` : "Network error",
				)
				.result();

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({ id: 1 });
			}
		});
	});
});
