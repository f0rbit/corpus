/**
 * @module testing/laws/provider-equivalence
 * @description Cross-provider equivalence law: run the same shrinkable command
 * sequence against an in-memory model and N provider-built systems-under-test,
 * asserting PER COMMAND that the model's result and each SUT's result agree —
 * `ok` flags match, ok-values agree under the caller's equality, error `kind`s
 * match. A divergence fails the property naming the provider label and command
 * index, and fast-check's native command shrinker reduces the failing sequence
 * to a minimal reproduction.
 *
 * Mechanics: `fc.commands` wraps every generated command in an internal
 * wrapper that only forwards `check`/`run`/`toString`, and `AsyncCommand.run`
 * is typed `Promise<void>` — so per-command results can't ride on the command
 * instance or its return value. The model object DOES flow through the wrapper
 * untouched, so this module keeps a private `WeakMap` keyed by model instance:
 * commands built with {@link equivalence_command} deposit `{ model_r, sut_r }`
 * into the mailbox of the model they just ran against, and the runner reads it
 * back right after each `run`. Hand-rolled `AsyncCommand`s that never deposit
 * an outcome are treated as self-asserting (their `run` throws on violation)
 * and skip the centralized equivalence check.
 */

import fc from "fast-check";
import { async_commands } from "../commands.js";
import type { AsyncCommand, CommandsConstraints } from "../commands.js";

type CommandOutcome = {
	readonly model_r: unknown;
	readonly sut_r: unknown;
};

type Mailbox = { outcome: CommandOutcome | undefined };

/**
 * Model-instance → outcome mailbox. Keyed by the model object because it is
 * the only value that passes through fast-check's command wrapper unchanged.
 * WeakMap so per-run models are GC'd with their mailboxes.
 */
const mailboxes = new WeakMap<object, Mailbox>();

/**
 * Read the mailbox through a call boundary: after `box.outcome = undefined`,
 * TS narrows the property to `undefined` and can't see that `cmd.run` mutates
 * it through the model-keyed alias — the function call resets the narrowing.
 */
const take_outcome = (box: Mailbox): CommandOutcome | undefined => box.outcome;

/**
 * Build an {@link AsyncCommand} that applies one logical operation to both the
 * model and the SUT, reporting both results to `provider_equivalence` for the
 * centralized per-command comparison.
 *
 * `on_model` runs first (synchronously — the model is an in-memory reference
 * implementation), then `on_sut`. Both share the result type `R` so the two
 * arms can't silently drift apart at the type level. The command carries no
 * run-scoped state of its own, so a single instance is safe to reuse across
 * positions, runs, and shrink retries (fast-check reuses command instances).
 *
 * Outside a `provider_equivalence` run there is no mailbox on the model, so
 * the command executes both arms but asserts nothing — these commands are
 * meant to be driven by the law, not by a bare `async_model_run`.
 *
 * @example
 * ```ts
 * const increment = testing.law.equivalence_command<CounterModel, Counter, Result<number, CounterError>>({
 *   label: "increment()",
 *   on_model: (m) => (m.count + 1 > CAP ? err({ kind: "overflow" }) : ok((m.count += 1))),
 *   on_sut: (c) => c.increment(),
 * })
 * ```
 */
export function equivalence_command<Model extends object, S, R>(opts: {
	label: string;
	check?: (m: Readonly<Model>) => boolean;
	on_model: (m: Model) => R;
	on_sut: (s: S) => R | Promise<R>;
}): AsyncCommand<Model, S> {
	return {
		check: (m) => (opts.check ? opts.check(m) : true),
		run: async (m, s) => {
			const model_r = opts.on_model(m);
			const sut_r = await opts.on_sut(s);
			const box = mailboxes.get(m);
			if (box) box.outcome = { model_r, sut_r };
		},
		toString: () => opts.label,
	};
}

type ResultShape = { ok: true; value: unknown } | { ok: false; error: unknown };

const as_result_shape = (v: unknown): ResultShape | undefined => {
	if (typeof v !== "object" || v === null || !("ok" in v)) return undefined;
	if (v.ok === true && "value" in v) return { ok: true, value: v.value };
	if (v.ok === false && "error" in v) return { ok: false, error: v.error };
	return undefined;
};

const error_kind = (e: unknown): string | undefined => {
	if (typeof e !== "object" || e === null || !("kind" in e)) return undefined;
	return typeof e.kind === "string" ? e.kind : undefined;
};

/**
 * Distinguish command instances from command arbitraries in the `commands`
 * pool. `instanceof` is the fast path; the structural fallback covers module
 * graphs carrying a duplicate fast-check copy, where the consumer's
 * `Arbitrary` is not an instance of OUR `fc.Arbitrary` class — without it, a
 * foreign arbitrary would get lifted via `fc.constant` and fail later with an
 * inscrutable `cmd.check is not a function`.
 */
const is_arbitrary = <Model extends object, S>(
	c: AsyncCommand<Model, S> | fc.Arbitrary<AsyncCommand<Model, S>>,
): c is fc.Arbitrary<AsyncCommand<Model, S>> => {
	if (c instanceof fc.Arbitrary) return true;
	return "generate" in c && typeof c.generate === "function" && "shrink" in c && typeof c.shrink === "function";
};

/** Returns a human-readable divergence reason, or undefined when results agree. */
const divergence = (
	model_r: unknown,
	sut_r: unknown,
	results_agree: (model_r: unknown, sut_r: unknown) => boolean,
): string | undefined => {
	const model_shape = as_result_shape(model_r);
	const sut_shape = as_result_shape(sut_r);
	if (model_shape === undefined || sut_shape === undefined) {
		return results_agree(model_r, sut_r) ? undefined : "results disagree under results_agree";
	}
	if (model_shape.ok !== sut_shape.ok) {
		return `ok flags disagree (model ok=${String(model_shape.ok)}, sut ok=${String(sut_shape.ok)})`;
	}
	if (model_shape.ok && sut_shape.ok) {
		return results_agree(model_shape.value, sut_shape.value) ? undefined : "ok values disagree under results_agree";
	}
	if (!model_shape.ok && !sut_shape.ok) {
		const model_kind = error_kind(model_shape.error);
		const sut_kind = error_kind(sut_shape.error);
		if (model_kind !== undefined && sut_kind !== undefined) {
			return model_kind === sut_kind ? undefined : `error kinds disagree (model='${model_kind}', sut='${sut_kind}')`;
		}
		return results_agree(model_r, sut_r)
			? undefined
			: "errors disagree under results_agree (no string `kind` on both errors)";
	}
	return undefined;
};

/**
 * Assert that every provider-built system behaves equivalently to the model
 * under arbitrary command sequences.
 *
 * Per property run: a FRESH model and a FRESH SUT are built for every provider
 * (the model factory is invoked once per provider so each pair evolves its own
 * deterministic reference copy), then the same generated command sequence runs
 * against each `(model, sut)` pair. After every command, results reported via
 * {@link equivalence_command} are compared:
 *
 * - both Result-shaped: `ok` flags must agree; when both `ok`, the unwrapped
 *   values must satisfy `equivalence.results_agree`; when both errors, string
 *   `error.kind`s must match (falling back to `results_agree` on the full
 *   results when either error carries no string `kind`)
 * - otherwise: the raw results must satisfy `equivalence.results_agree`
 *
 * A divergence throws with the provider label, command index, command label,
 * and the executed sequence — and fast-check's command shrinker reduces the
 * failing sequence to a minimal counterexample. Shrinking is deliberately left
 * ENABLED here (no `endOnFailure`): the minimal command sequence is the value
 * of this law.
 *
 * WARNING — payload arbitraries inside commands must be plain fast-check
 * arbitraries (`fc.integer`, `fc.string`, `fc.record`, ...). `testing.compose`
 * is built on `fc.gen()`, whose shrinker does not reliably terminate
 * (fast-check 4.8); a compose-based payload inside a command can hang the
 * shrink phase of a failing run. If a command's payload must come from
 * `testing.compose` / `testing.arb`-over-compose, pre-sample values with
 * `fc.sample` (unaffected) and pass fixed-payload command instances instead.
 *
 * @param opts.model - Factory for the reference model; MUST return a fresh
 * instance per call (enforced at runtime)
 * @param opts.providers - Labelled factories, one per system-under-test
 * @param opts.commands - Command pool: instances and/or arbitraries of
 * commands (instances are lifted via `fc.constant`)
 * @param opts.equivalence.results_agree - Equality for ok-values (or for raw
 * results when they aren't Result-shaped)
 * @param opts.numRuns - Property runs (default: fast-check's default, 100)
 * @param opts.maxCommands - Max commands per generated sequence (default:
 * fast-check's default sizing)
 * @param opts.size - fast-check size bias for sequence LENGTH. With the
 * default sizing, `maxCommands: 30` still averages ~5 commands per sequence
 * (p90 ≈ 9); pass `"max"` to bias lengths toward `maxCommands` when deep
 * stateful histories are the point of the law
 *
 * @example
 * ```ts
 * await testing.law.provider_equivalence({
 *   model: () => ({ count: 0 }),
 *   providers: [
 *     { label: "memory", build: () => make_memory_counter() },
 *     { label: "file", build: () => make_file_counter(tmp_dir()) },
 *   ],
 *   commands: [
 *     increment_command,
 *     testing.fc.integer({ min: 1, max: 5 }).map((n) => add_command(n)),
 *   ],
 *   equivalence: { results_agree: (a, b) => a === b },
 *   numRuns: 200,
 *   maxCommands: 30,
 * })
 * ```
 */
export async function provider_equivalence<Model extends object, S>(opts: {
	model: () => Model | Promise<Model>;
	providers: ReadonlyArray<{ label: string; build: () => S | Promise<S> }>;
	commands: ReadonlyArray<AsyncCommand<Model, S> | fc.Arbitrary<AsyncCommand<Model, S>>>;
	equivalence: { results_agree: (model_r: unknown, sut_r: unknown) => boolean };
	numRuns?: number;
	maxCommands?: number;
	size?: CommandsConstraints["size"];
}): Promise<void> {
	const command_arbs = opts.commands.map((c) => (is_arbitrary(c) ? c : fc.constant(c)));
	const sequences = async_commands<Model, S>(command_arbs, {
		...(opts.maxCommands === undefined ? {} : { maxCommands: opts.maxCommands }),
		...(opts.size === undefined ? {} : { size: opts.size }),
	});

	await fc.assert(
		fc.asyncProperty(sequences, async (cmds) => {
			const pairs: Array<{ label: string; model: Model; sut: S; box: Mailbox }> = [];
			for (const provider of opts.providers) {
				const model = await opts.model();
				if (mailboxes.has(model)) {
					throw new Error(
						`provider_equivalence: model() returned an instance already in use (building provider "${provider.label}") — the factory must build a FRESH model per call`,
					);
				}
				const box: Mailbox = { outcome: undefined };
				mailboxes.set(model, box);
				pairs.push({ label: provider.label, model, sut: await provider.build(), box });
			}

			const executed: string[] = [];
			let index = 0;
			for (const cmd of cmds) {
				const label = String(cmd);
				let ran = false;
				for (const pair of pairs) {
					if (!cmd.check(pair.model)) continue;
					ran = true;
					pair.box.outcome = undefined;
					await cmd.run(pair.model, pair.sut);
					const outcome = take_outcome(pair.box);
					if (outcome === undefined) continue;
					const reason = divergence(outcome.model_r, outcome.sut_r, opts.equivalence.results_agree);
					if (reason !== undefined) {
						throw new Error(
							`provider_equivalence: ${reason} — provider "${pair.label}", command #${String(index)} (${label}), sequence: [${[...executed, label].join(", ")}], model_r=${fc.stringify(outcome.model_r)}, sut_r=${fc.stringify(outcome.sut_r)}`,
						);
					}
				}
				if (ran) executed.push(label);
				index += 1;
			}
		}),
		// No endOnFailure: sequence shrinking is the point of this law. Safe
		// because fc.commands' shrinker terminates — the non-terminating-shrink
		// hazard is specific to fc.gen()/compose-based arbitraries (AGENTS.md).
		opts.numRuns === undefined ? {} : { numRuns: opts.numRuns },
	);
}
