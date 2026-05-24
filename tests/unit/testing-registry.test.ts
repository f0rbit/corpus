import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fc from "fast-check";
import { z } from "zod";
import {
	arbitrary,
	lookup,
	failure,
	lookup_failure,
	__reset_registry_for_tests,
} from "../../testing/registry";
import type { ArbBrand } from "../../testing/types";

type UserId = string & { readonly __brand: unique symbol };
type OrderId = number & { readonly __brand: unique symbol };

type DemoError =
	| { kind: "not_found"; id: string }
	| { kind: "denied"; reason: string };

const USER_ID_BRAND = Symbol("UserId") as ArbBrand<UserId>;
const ORDER_ID_BRAND = Symbol("OrderId") as ArbBrand<OrderId>;
const DEMO_ERROR_BRAND = Symbol("DemoError") as ArbBrand<DemoError>;

describe("testing/registry", () => {
	beforeEach(() => {
		__reset_registry_for_tests();
	});

	describe("brand registration", () => {
		test("register-then-lookup round-trips", () => {
			const gen = fc.constant("u123" as UserId);
			arbitrary(USER_ID_BRAND, gen);
			expect(lookup(USER_ID_BRAND)).toBe(gen);
		});

		test("lookup returns undefined for unregistered brand", () => {
			expect(lookup(USER_ID_BRAND)).toBeUndefined();
		});

		test("distinct brands do not collide", () => {
			const user_gen = fc.constant("u" as UserId);
			const order_gen = fc.constant(1 as unknown as OrderId);
			arbitrary(USER_ID_BRAND, user_gen);
			arbitrary(ORDER_ID_BRAND, order_gen);
			expect(lookup(USER_ID_BRAND)).toBe(user_gen);
			expect(lookup(ORDER_ID_BRAND)).toBe(order_gen);
		});

		test("duplicate registration overwrites and warns", () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const first = fc.constant("a" as UserId);
				const second = fc.constant("b" as UserId);
				arbitrary(USER_ID_BRAND, first);
				arbitrary(USER_ID_BRAND, second);
				expect(lookup(USER_ID_BRAND)).toBe(second);
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("schema registration", () => {
		test("register-then-lookup round-trips on schema identity", () => {
			const schema = z.object({ id: z.string() });
			const gen = fc.record({ id: fc.string() });
			arbitrary(schema, gen);
			expect(lookup(schema)).toBe(gen);
		});

		test("lookup returns undefined for unregistered schema", () => {
			const schema = z.object({ id: z.string() });
			expect(lookup(schema)).toBeUndefined();
		});

		test("structurally equal but distinct schema instances do not share registration", () => {
			const a = z.object({ id: z.string() });
			const b = z.object({ id: z.string() });
			const gen = fc.record({ id: fc.string() });
			arbitrary(a, gen);
			expect(lookup(a)).toBe(gen);
			expect(lookup(b)).toBeUndefined();
		});

		test("duplicate schema registration overwrites and warns", () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const schema = z.string();
				const first = fc.constant("a");
				const second = fc.constant("b");
				arbitrary(schema, first);
				arbitrary(schema, second);
				expect(lookup(schema)).toBe(second);
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("failure registration", () => {
		test("failure + lookup_failure round-trips per variant", () => {
			const not_found_gen = fc.record({
				kind: fc.constant("not_found" as const),
				id: fc.string(),
			});
			const denied_gen = fc.record({
				kind: fc.constant("denied" as const),
				reason: fc.string(),
			});
			failure(DEMO_ERROR_BRAND, "not_found", not_found_gen);
			failure(DEMO_ERROR_BRAND, "denied", denied_gen);
			expect(lookup_failure(DEMO_ERROR_BRAND, "not_found")).toBe(not_found_gen);
			expect(lookup_failure(DEMO_ERROR_BRAND, "denied")).toBe(denied_gen);
		});

		test("lookup_failure returns undefined for unregistered brand", () => {
			expect(lookup_failure(DEMO_ERROR_BRAND, "not_found")).toBeUndefined();
		});

		test("lookup_failure returns undefined for unregistered variant under known brand", () => {
			const not_found_gen = fc.record({
				kind: fc.constant("not_found" as const),
				id: fc.string(),
			});
			failure(DEMO_ERROR_BRAND, "not_found", not_found_gen);
			expect(lookup_failure(DEMO_ERROR_BRAND, "denied")).toBeUndefined();
		});

		test("duplicate failure registration overwrites and warns", () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				const first = fc.record({
					kind: fc.constant("not_found" as const),
					id: fc.constant("first"),
				});
				const second = fc.record({
					kind: fc.constant("not_found" as const),
					id: fc.constant("second"),
				});
				failure(DEMO_ERROR_BRAND, "not_found", first);
				failure(DEMO_ERROR_BRAND, "not_found", second);
				expect(lookup_failure(DEMO_ERROR_BRAND, "not_found")).toBe(second);
				expect(warn).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		});
	});

	describe("__reset_registry_for_tests", () => {
		test("clears brand, schema, and failure registries", () => {
			const schema = z.string();
			arbitrary(USER_ID_BRAND, fc.constant("u" as UserId));
			arbitrary(schema, fc.constant("x"));
			failure(
				DEMO_ERROR_BRAND,
				"not_found",
				fc.record({ kind: fc.constant("not_found" as const), id: fc.string() })
			);

			__reset_registry_for_tests();

			expect(lookup(USER_ID_BRAND)).toBeUndefined();
			expect(lookup(schema)).toBeUndefined();
			expect(lookup_failure(DEMO_ERROR_BRAND, "not_found")).toBeUndefined();
		});
	});
});
