/**
 * @module testing
 * @description Property-based testing substrate for corpus.
 *
 * Exports:
 * - {@link arb} — Zod schema → `fc.Arbitrary` deriver with registry integration
 * - {@link compose} — Hypothesis-style composite generator with dependent draws
 * - {@link arbitrary} / {@link lookup} — Register and look up arbitraries by brand or schema
 *   (`lookup` is async — the first call auto-loads registrars vended via
 *   `"corpus": { "testing": ... }` package.json keys of direct dependencies)
 * - {@link failure} / {@link lookup_failure} — Register / look up error-variant-specific generators
 * - {@link load_from} — Explicitly load one package's registrar by name or directory
 * - {@link list_registered_variants} — Enumerate the variants registered under a brand
 * - {@link register} — Corpus's own registrar (explicit call; does not auto-run on import)
 * - {@link CORPUS_ERROR_BRAND} / {@link SNAPSHOT_META_BRAND} / {@link BATCH_OP_BRAND} — Brand symbols for corpus types
 * - {@link cover} — Hedgehog-style coverage assertion ({@link cover_property} aliased)
 * - {@link commands} / {@link async_commands} / {@link model_run} / {@link async_model_run} — Typed pin of fast-check's model-based command API
 * - {@link law} — Law helpers namespace: `law.round_trip`, `law.idempotent`, `law.functor`, `law.error_path_exhaustive`, `law.provider_equivalence`, `law.equivalence_command`
 * - {@link ArbBrand} / {@link FailureKey} — Type-level utilities for branded registration
 * - {@link __reset_registry_for_tests} — Clear registries (test-only)
 * - {@link fc} — fast-check as a convenience re-export (consumers don't need separate import)
 */

export { arb } from './arb.js';
export { compose, type Draw } from './compose.js';
export { arbitrary, lookup, __reset_registry_for_tests } from './registry.js';
export { failure, lookup_failure, list_registered_variants } from './failure.js';
export { load_from } from './vending/auto-load.js';
export { register, CORPUS_ERROR_BRAND, SNAPSHOT_META_BRAND, BATCH_OP_BRAND } from './register.js';
export { cover_property as cover, CoverageError, DEFAULT_NUM_RUNS, type CoverageLabel, type CoverageStat } from './cover.js';
export { commands, async_commands, model_run, async_model_run } from './commands.js';
export type { Command, AsyncCommand, ICommand, ModelRunSetup, ModelRunAsyncSetup, CommandsConstraints } from './commands.js';
export type { ArbBrand, FailureKey } from './types.js';
export * as law from './laws/index.js';
export { default as fc } from 'fast-check';
