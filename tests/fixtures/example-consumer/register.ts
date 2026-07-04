/**
 * Pilot fixture: a package pretending to be vault, vending its testing
 * arbitraries through the `"corpus": { "testing": "./register.ts" }` key.
 *
 * Registration happens ONLY inside {@link register} — importing this module
 * is side-effect-free, so consumers (and the pilot test) can import the brand
 * symbols for identity without registering anything. The vending walker
 * imports the module and invokes `register()`.
 */

import fc from "fast-check";
import { z } from "zod";
import { compose } from "../../../testing/compose";
import { failure } from "../../../testing/failure";
import { arbitrary } from "../../../testing/registry";
import type { ArbBrand } from "../../../testing/types";

export type AuthToken = string & { readonly __brand: "AuthToken" };

export type VaultError =
	| { kind: "rate_limited"; retry_after_ms: number }
	| { kind: "unauthorized"; token: AuthToken };

const AUTH_TOKEN_PATTERN = /^vlt_[a-f0-9]{32}$/;

export const auth_token_schema = z
	.string()
	.regex(AUTH_TOKEN_PATTERN)
	.transform((s) => s as AuthToken);

export const AUTH_TOKEN_BRAND = Symbol("example-consumer/AuthToken") as ArbBrand<AuthToken>;
export const VAULT_ERROR_BRAND = Symbol("example-consumer/VaultError") as ArbBrand<VaultError>;

const auth_token_arb: fc.Arbitrary<AuthToken> = fc.stringMatching(AUTH_TOKEN_PATTERN).map((s) => s as AuthToken);

export function register(): void {
	arbitrary(AUTH_TOKEN_BRAND, auth_token_arb);
	failure(
		VAULT_ERROR_BRAND,
		"rate_limited",
		compose((draw) => ({
			kind: "rate_limited" as const,
			retry_after_ms: draw(fc.integer({ min: 0, max: 60_000 })),
		})),
	);
}
