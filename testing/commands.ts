/**
 * @module testing/commands
 * @description Typed pin of fast-check's model-based command API.
 *
 * Corpus is the only place fast-check is configured — downstream packages go
 * through `testing.*` rather than importing `"fast-check"` directly. This
 * module re-exports the command surface so that a fast-check upgrade renaming
 * or reshaping `commands`, `modelRun`, `asyncModelRun`, or the command
 * interfaces becomes a COMPILE error here in corpus, not a runtime failure in
 * a downstream package.
 *
 * fast-check has no separate `asyncCommands` entry point — `fc.commands` is
 * overloaded over both `Command` and `AsyncCommand` arrays. {@link async_commands}
 * pins the async overload explicitly so its exact signature is compile-checked
 * too.
 */

import { commands } from "fast-check";
import type { Arbitrary, AsyncCommand, CommandsContraints } from "fast-check";

export { commands, modelRun as model_run, asyncModelRun as async_model_run } from "fast-check";
export type {
	Command,
	AsyncCommand,
	ICommand,
	ModelRunSetup,
	ModelRunAsyncSetup,
	// fast-check spells this `CommandsContraints` (sic, missing an `s`) — corpus
	// exports the corrected name. If fast-check ever fixes the typo upstream,
	// this re-export breaks the build, which is exactly the point of this module.
	CommandsContraints as CommandsConstraints,
} from "fast-check";

/**
 * Generate shrinkable sequences of {@link AsyncCommand}s.
 *
 * This is the async overload of `fc.commands`, pinned with an explicit
 * signature: sequences generated here shrink natively (fast-check's command
 * shrinker drops commands and shrinks their payload arbitraries) and are what
 * `testing.law.provider_equivalence` runs internally.
 *
 * @param command_arbs - One arbitrary per command shape; mix payload-free
 * `fc.constant(cmd)` entries with payload-carrying `fc.integer().map((n) => cmd(n))` entries
 * @param constraints - Optional fast-check command constraints (e.g. `maxCommands`)
 *
 * @example
 * ```ts
 * import { testing } from "@f0rbit/corpus"
 * import { async_commands, async_model_run } from "@f0rbit/corpus/testing/commands"
 *
 * const sequences = async_commands<CounterModel, Counter>([
 *   testing.fc.constant(increment_command),
 *   testing.fc.integer({ min: 1, max: 5 }).map((n) => add_command(n)),
 * ], { maxCommands: 20 })
 *
 * await testing.fc.assert(
 *   testing.fc.asyncProperty(sequences, (cmds) =>
 *     async_model_run(() => ({ model: { count: 0 }, real: make_counter() }), cmds),
 *   ),
 * )
 * ```
 */
export function async_commands<Model extends object, S>(
	command_arbs: ReadonlyArray<Arbitrary<AsyncCommand<Model, S>>>,
	constraints?: CommandsContraints,
): Arbitrary<Iterable<AsyncCommand<Model, S>>> {
	return commands([...command_arbs], constraints);
}
