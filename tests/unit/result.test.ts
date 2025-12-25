import { describe, test, expect, mock, afterEach } from "bun:test";
import { match, unwrap_or, unwrap, unwrap_err, try_catch, try_catch_async, fetch_result, type FetchError, pipe, to_nullable, to_fallback, null_on, fallback_on, format_error } from "../../result";
import { ok, err, type Result } from "../../types";

const mockFetch = (fn: () => Promise<Response>): void => {
	globalThis.fetch = fn as unknown as typeof fetch;
};

describe("Result Utilities", () => {
	describe("match", () => {
		test("calls on_ok for success result", () => {
			const result = ok(42);
			const output = match(
				result,
				value => `success: ${value}`,
				error => `error: ${error}`
			);
			expect(output).toBe("success: 42");
		});

		test("calls on_err for error result", () => {
			const result = err("something went wrong");
			const output = match(
				result,
				value => `success: ${value}`,
				error => `error: ${error}`
			);
			expect(output).toBe("error: something went wrong");
		});

		test("transforms ok value to different type", () => {
			const result = ok({ name: "Alice", age: 30 });
			const output = match(
				result,
				user => user.age * 2,
				() => 0
			);
			expect(output).toBe(60);
		});

		test("transforms error value to different type", () => {
			const result = err({ code: 404, message: "Not found" });
			const output = match(
				result,
				() => null,
				error => error.code
			);
			expect(output).toBe(404);
		});
	});

	describe("unwrap_or", () => {
		test("returns value for ok result", () => {
			const result = ok(42);
			expect(unwrap_or(result, 0)).toBe(42);
		});

		test("returns default for error result", () => {
			const result = err("error");
			expect(unwrap_or(result, 100)).toBe(100);
		});

		test("returns empty array as default", () => {
			const result: Result<number[], string> = err("no data");
			expect(unwrap_or(result, [])).toEqual([]);
		});

		test("returns null as default", () => {
			const result: Result<string | null, string> = err("missing");
			expect(unwrap_or(result, null)).toBeNull();
		});

		test("returns complex object as default", () => {
			const fallback = { status: "unknown", count: 0 };
			const result: Result<typeof fallback, string> = err("failed");
			expect(unwrap_or(result, fallback)).toEqual(fallback);
		});
	});

	describe("unwrap", () => {
		test("returns value for ok result", () => {
			const result = ok({ data: "test" });
			expect(unwrap(result)).toEqual({ data: "test" });
		});

		test("throws for error result", () => {
			const result = err("something failed");
			expect(() => unwrap(result)).toThrow("unwrap called on error result");
		});

		test("includes error in thrown message", () => {
			const result = err({ code: 500, message: "Internal error" });
			expect(() => unwrap(result)).toThrow('"code":500');
		});

		test("returns primitive value", () => {
			const result = ok(123);
			expect(unwrap(result)).toBe(123);
		});
	});

	describe("unwrap_err", () => {
		test("returns error for error result", () => {
			const result = err({ kind: "not_found", id: "123" });
			expect(unwrap_err(result)).toEqual({ kind: "not_found", id: "123" });
		});

		test("throws for ok result", () => {
			const result = ok("success");
			expect(() => unwrap_err(result)).toThrow("unwrap_err called on ok result");
		});

		test("includes value in thrown message", () => {
			const result = ok({ name: "Alice" });
			expect(() => unwrap_err(result)).toThrow('"name":"Alice"');
		});

		test("returns primitive error", () => {
			const result = err("simple error");
			expect(unwrap_err(result)).toBe("simple error");
		});
	});

	describe("try_catch", () => {
		test("returns ok for successful function", () => {
			const result = try_catch(
				() => JSON.parse('{"value": 42}'),
				e => format_error(e)
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({ value: 42 });
			}
		});

		test("returns error for thrown exception", () => {
			const result = try_catch(
				() => JSON.parse("invalid json"),
				e => `parse error: ${format_error(e)}`
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toContain("parse error:");
			}
		});

		test("uses custom error mapper", () => {
			const result = try_catch(
				() => {
					throw new Error("custom error");
				},
				e => ({ kind: "custom", message: format_error(e) })
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toEqual({ kind: "custom", message: "custom error" });
			}
		});

		test("handles non-Error thrown values", () => {
			const result = try_catch(
				() => {
					throw "string error";
				},
				e => format_error(e)
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("string error");
			}
		});

		test("returns correct value type", () => {
			const result = try_catch(
				() => [1, 2, 3].map(x => x * 2),
				() => [] as number[]
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual([2, 4, 6]);
			}
		});
	});

	describe("try_catch_async", () => {
		test("returns ok for successful async function", async () => {
			const result = await try_catch_async(
				async () => Promise.resolve(42),
				e => format_error(e)
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe(42);
			}
		});

		test("returns error for rejected promise", async () => {
			const result = await try_catch_async(
				async () => Promise.reject(new Error("async failure")),
				e => `async error: ${format_error(e)}`
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("async error: async failure");
			}
		});

		test("uses custom error mapper for async errors", async () => {
			const result = await try_catch_async(
				async () => {
					throw { code: 500 };
				},
				e => ({ kind: "server_error", cause: e })
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("server_error");
				expect((result.error.cause as { code: number }).code).toBe(500);
			}
		});

		test("handles delayed async operations", async () => {
			const result = await try_catch_async(
				async () => {
					await new Promise(r => setTimeout(r, 10));
					return "delayed result";
				},
				e => format_error(e)
			);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe("delayed result");
			}
		});

		test("handles thrown error in async function", async () => {
			const result = await try_catch_async(
				async () => {
					await Promise.resolve();
					throw new Error("thrown after await");
				},
				e => format_error(e)
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("thrown after await");
			}
		});
	});

	describe("fetch_result", () => {
		const originalFetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		test("returns ok for successful fetch with JSON", async () => {
			mockFetch(() => Promise.resolve(new Response(JSON.stringify({ data: "test" }), { status: 200 })));

			const result = await fetch_result("https://api.example.com/data", undefined, e => e);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toEqual({ data: "test" });
			}
		});

		test("returns HTTP error for non-ok response", async () => {
			mockFetch(() => Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })));

			const result = await fetch_result<unknown, FetchError>("https://api.example.com/missing", undefined, e => e);

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
			mockFetch(() => Promise.reject(new Error("Network failure")));

			const result = await fetch_result<unknown, FetchError>("https://api.example.com/data", undefined, e => e);

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.type).toBe("network");
			}
		});

		test("returns parse error when JSON parsing fails", async () => {
			mockFetch(() => Promise.resolve(new Response("not json", { status: 200 })));

			const result = await fetch_result<unknown, string>("https://api.example.com/data", undefined, e => (e.type === "network" ? "parse failed" : "http error"));

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("parse failed");
			}
		});

		test("uses custom error mapper", async () => {
			mockFetch(() => Promise.resolve(new Response("", { status: 500, statusText: "Server Error" })));

			const result = await fetch_result<unknown, string>("https://api.example.com/data", undefined, e => (e.type === "http" ? `HTTP ${e.status}` : "Network error"));

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toBe("HTTP 500");
			}
		});

		test("uses custom body parser", async () => {
			mockFetch(() => Promise.resolve(new Response("plain text response", { status: 200 })));

			const result = await fetch_result<string, FetchError>(
				"https://api.example.com/text",
				undefined,
				e => e,
				response => response.text()
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe("plain text response");
			}
		});

		test("passes request init options", async () => {
			let capturedInit: RequestInit | undefined;
			const mockFn = mock((_input: string | Request | URL, init?: RequestInit) => {
				capturedInit = init;
				return Promise.resolve(new Response("{}", { status: 200 }));
			});
			globalThis.fetch = mockFn as unknown as typeof fetch;

			await fetch_result(
				"https://api.example.com/data",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: "value" }),
				},
				e => e
			);

			expect(capturedInit?.method).toBe("POST");
			expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });
		});
	});

	describe("pipe", () => {
		const originalFetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		describe("factory methods", () => {
			test("pipe.ok creates ok pipe", async () => {
				const result = await pipe.ok(42).result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(42);
				}
			});

			test("pipe.err creates error pipe", async () => {
				const result = await pipe.err("error message").result();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("error message");
				}
			});

			test("pipe.try wraps async function", async () => {
				const result = await pipe
					.try(
						async () => 42,
						e => format_error(e)
					)
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(42);
				}
			});

			test("pipe.try catches async errors", async () => {
				const result = await pipe
					.try(
						async () => {
							throw new Error("failed");
						},
						e => format_error(e)
					)
					.result();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("failed");
				}
			});

			test("pipe.fetch wraps fetch operation", async () => {
				mockFetch(() => Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200 })));

				const result = await pipe.fetch<{ id: number }, string>("https://api.example.com/item", undefined, e => (e.type === "http" ? `HTTP ${e.status}` : "Network error")).result();

				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toEqual({ id: 1 });
				}
			});
		});

		describe("chaining operations", () => {
			test("map transforms ok value", async () => {
				const result = await pipe
					.ok(10)
					.map(x => x * 2)
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(20);
				}
			});

			test("map skips error", async () => {
				const initial: Result<number, string> = err("error");
				const result = await pipe(initial)
					.map(x => x * 2)
					.result();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("error");
				}
			});

			test("map_async transforms ok value asynchronously", async () => {
				const result = await pipe
					.ok(5)
					.map_async(async x => {
						await new Promise(r => setTimeout(r, 1));
						return x * 3;
					})
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(15);
				}
			});

			test("map_err transforms error value", async () => {
				const initial: Result<number, string> = err("raw error");
				const result = await pipe(initial)
					.map_err(e => ({ message: e, code: 500 }))
					.result();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toEqual({ message: "raw error", code: 500 });
				}
			});

			test("map_err skips ok value", async () => {
				const initial: Result<number, string> = ok(42);
				const result = await pipe(initial)
					.map_err(e => ({ message: e }))
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(42);
				}
			});

			test("flat_map chains result operations", async () => {
				const divide = (a: number, b: number): Result<number, string> => (b === 0 ? err("division by zero") : ok(a / b));

				const initial: Result<number, string> = ok(10);
				const result = await pipe(initial)
					.flat_map(x => divide(x, 2))
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe(5);
				}
			});

			test("flat_map short-circuits on error", async () => {
				const divide = (a: number, b: number): Result<number, string> => (b === 0 ? err("division by zero") : ok(a / b));

				const initial: Result<number, string> = ok(10);
				const result = await pipe(initial)
					.flat_map(x => divide(x, 0))
					.flat_map(x => divide(x, 2))
					.result();
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error).toBe("division by zero");
				}
			});

			test("tap executes side effect on ok", async () => {
				const captured: number[] = [];
				const result = await pipe
					.ok(42)
					.tap(x => {
						captured.push(x);
					})
					.result();
				expect(result.ok).toBe(true);
				expect(captured).toEqual([42]);
			});

			test("tap skips side effect on error", async () => {
				const captured: number[] = [];
				const initial: Result<number, string> = err("error");
				const result = await pipe(initial)
					.tap(x => {
						captured.push(x);
					})
					.result();
				expect(result.ok).toBe(false);
				expect(captured).toEqual([]);
			});

			test("tap_err executes side effect on error", async () => {
				const captured: string[] = [];
				const initial: Result<number, string> = err("error message");
				const result = await pipe(initial)
					.tap_err(e => {
						captured.push(e);
					})
					.result();
				expect(result.ok).toBe(false);
				expect(captured).toEqual(["error message"]);
			});

			test("tap_err skips side effect on ok", async () => {
				const captured: string[] = [];
				const initial: Result<number, string> = ok(42);
				const result = await pipe(initial)
					.tap_err(e => {
						captured.push(e);
					})
					.result();
				expect(result.ok).toBe(true);
				expect(captured).toEqual([]);
			});

			test("unwrap_or returns value on ok", async () => {
				const value = await pipe.ok(42).unwrap_or(0);
				expect(value).toBe(42);
			});

			test("unwrap_or returns default on error", async () => {
				const initial: Result<number, string> = err("error");
				const value = await pipe(initial).unwrap_or(100);
				expect(value).toBe(100);
			});

			test("chains multiple operations", async () => {
				const result = await pipe
					.ok({ x: 5, y: 10 })
					.map(coords => coords.x + coords.y)
					.map(sum => sum * 2)
					.map(doubled => `result: ${doubled}`)
					.result();
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.value).toBe("result: 30");
				}
			});
		});
	});

	describe("to_nullable", () => {
		test("returns value for ok result", () => {
			const result = ok({ name: "Alice" });
			expect(to_nullable(result)).toEqual({ name: "Alice" });
		});

		test("returns null for error result", () => {
			const result = err("not found");
			expect(to_nullable(result)).toBeNull();
		});

		test("returns primitive value for ok result", () => {
			const result = ok(42);
			expect(to_nullable(result)).toBe(42);
		});

		test("returns null for any error type", () => {
			const result = err({ kind: "not_found", id: "123" });
			expect(to_nullable(result)).toBeNull();
		});
	});

	describe("to_fallback", () => {
		test("returns value for ok result", () => {
			const result = ok([1, 2, 3]);
			expect(to_fallback(result, [])).toEqual([1, 2, 3]);
		});

		test("returns fallback for error result", () => {
			const result: Result<number[], string> = err("failed");
			expect(to_fallback(result, [0])).toEqual([0]);
		});

		test("returns empty array fallback", () => {
			const result: Result<number[], string> = err("no items");
			expect(to_fallback(result, [])).toEqual([]);
		});

		test("returns complex fallback object", () => {
			const fallback = { count: 0, items: [] as number[] };
			const result: Result<typeof fallback, string> = err("failed");
			expect(to_fallback(result, fallback)).toEqual(fallback);
		});
	});

	describe("null_on", () => {
		test("returns value for ok result", () => {
			const result: Result<string, string> = ok("data");
			expect(null_on(result, e => e === "not_found")).toBe("data");
		});

		test("returns null when predicate matches error", () => {
			const result = err({ kind: "not_found" });
			expect(null_on(result, e => e.kind === "not_found")).toBeNull();
		});

		test("throws when predicate does not match error", () => {
			const result = err({ kind: "server_error" });
			expect(() => null_on(result, e => e.kind === "not_found")).toThrow();
		});

		test("throws the actual error object", () => {
			const error = { kind: "server_error", code: 500 };
			const result = err(error);
			try {
				null_on(result, e => e.kind === "not_found");
				expect(true).toBe(false);
			} catch (e) {
				expect(e).toEqual(error);
			}
		});

		test("predicate receives error value", () => {
			let captured: unknown = null;
			const result = err("specific error");
			null_on(result, e => {
				captured = e;
				return true;
			});
			expect(captured).toBe("specific error");
		});
	});

	describe("fallback_on", () => {
		test("returns value for ok result", () => {
			const result: Result<number, string> = ok(42);
			expect(fallback_on(result, e => e === "not_found", 0)).toBe(42);
		});

		test("returns fallback when predicate matches error", () => {
			const result: Result<number, { kind: string }> = err({ kind: "not_found" });
			expect(fallback_on(result, e => e.kind === "not_found", 0)).toBe(0);
		});

		test("throws when predicate does not match error", () => {
			const result: Result<number, { kind: string }> = err({ kind: "server_error" });
			expect(() => fallback_on(result, e => e.kind === "not_found", 0)).toThrow();
		});

		test("throws the actual error object", () => {
			const error = { kind: "forbidden" };
			const result: Result<number, typeof error> = err(error);
			try {
				fallback_on(result, e => e.kind === "not_found", 0);
				expect(true).toBe(false);
			} catch (e) {
				expect(e).toEqual(error);
			}
		});

		test("uses custom fallback value", () => {
			const fallback = { items: [] as number[], total: 0 };
			const result: Result<typeof fallback, { kind: string }> = err({ kind: "empty" });
			expect(fallback_on(result, e => e.kind === "empty", fallback)).toEqual(fallback);
		});
	});

	describe("format_error", () => {
		test("formats Error instance", () => {
			const error = new Error("Something went wrong");
			expect(format_error(error)).toBe("Something went wrong");
		});

		test("formats string directly", () => {
			expect(format_error("plain string error")).toBe("plain string error");
		});

		test("formats object using String()", () => {
			const obj = { code: 500 };
			expect(format_error(obj)).toBe("[object Object]");
		});

		test("formats number", () => {
			expect(format_error(404)).toBe("404");
		});

		test("formats null", () => {
			expect(format_error(null)).toBe("null");
		});

		test("formats undefined", () => {
			expect(format_error(undefined)).toBe("undefined");
		});

		test("formats boolean", () => {
			expect(format_error(false)).toBe("false");
		});

		test("formats custom Error subclass", () => {
			class CustomError extends Error {
				constructor(message: string) {
					super(message);
					this.name = "CustomError";
				}
			}
			const error = new CustomError("Custom message");
			expect(format_error(error)).toBe("Custom message");
		});
	});
});
