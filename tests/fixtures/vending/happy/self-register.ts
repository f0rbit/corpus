import fc from "fast-check";
import { arbitrary } from "../../../../testing/registry";
import type { ArbBrand } from "../../../../testing/types";

export type HappyMarker = string & { readonly __brand: "HappyMarker" };

export const HAPPY_MARKER_BRAND = Symbol("vending-happy/HappyMarker") as ArbBrand<HappyMarker>;

export const calls = { count: 0 };

export function register(): void {
	calls.count += 1;
	arbitrary(HAPPY_MARKER_BRAND, fc.constant("happy" as HappyMarker));
}
