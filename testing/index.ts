/**
 * @module testing
 * @description Property-based testing substrate for corpus.
 *
 * Exports:
 * - {@link arb} — Zod schema → `fc.Arbitrary` deriver with registry integration
 * - {@link compose} — Hypothesis-style composite generator with dependent draws
 * - {@link arbitrary} / {@link lookup} — Register and look up arbitraries by brand or schema
 * - {@link failure} / {@link lookup_failure} — Register error-variant-specific generators
 * - {@link ArbBrand} / {@link FailureKey} — Type-level utilities for branded registration
 * - {@link __reset_registry_for_tests} — Clear registries (test-only)
 * - {@link fc} — fast-check as a convenience re-export (consumers don't need separate import)
 */

export { arb } from './arb.js';
export { compose, type Draw } from './compose.js';
export { arbitrary, lookup, failure, lookup_failure, __reset_registry_for_tests } from './registry.js';
export type { ArbBrand, FailureKey } from './types.js';
export { default as fc } from 'fast-check';
