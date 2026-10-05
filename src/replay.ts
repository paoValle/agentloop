/**
 * Replay: redoing a run from a trace, with no network and no provider.
 *
 * It is the promise of ADR 0001 made executable, and it depends entirely on the fact
 * that `Policy` and `Tool` are interfaces: here there is no second code path to
 * maintain, there is the same loop with a `Policy` that reads from disk inside it.
 *
 * Three modes, declared by the caller (ADR 0003):
 *
 * | mode         | policy       | tool          | what it is for                        |
 * |--------------|--------------|---------------|---------------------------------------|
 * | `full`       | from trace   | from trace    | regression tests on the loop, offline |
 * | `live-tools` | from trace   | real ones     | "what changes if the tool changes?"   |
 * | `dry-run`    | from trace   | skipped       | how much of the run depends on tools? |
 *
 * In `full` and `dry-run` no tool code is executed: the output comes from the trace.
 * That is why replay works even for a tool that calls a service that no longer exists.
 */

import { Budget, type Price } from './budget.js';
import { ReplayMismatchError } from './errors.js';
import { run, type RunOptions, type RunResult } from './loop.js';
import { Trace, type ToolOutcomeTrace } from './trace.js';
import { ReplayedFailure, ToolRegistry } from './tool.js';
import type { AnyTool, Policy, PolicyOutcome } from './types.js';

/** How to treat tools during replay. */
export type ReplayMode = 'full' | 'live-tools' | 'dry-run';

/** Something replay noticed and that deserves to be said. */
export interface ReplayWarning {
  readonly kind: 'tool_changed' | 'tool_missing' | 'extra_tool';
  readonly tool: string;
  readonly message: string;
}

export interface ReplayOptions {
  /** The real tools. Required only in `live-tools`, where they are actually executed. */
  readonly tools?: ToolRegistry;
  /** Mode. Defaults to `full`. */
  readonly mode?: ReplayMode;
  /**
   * If `true` (default), the produced trace is compared with the original one and
   * `equal` says whether they match. Needed because a replay that "reproduces" but
   * produces something else is worse than a replay that fails loudly.
   */
  readonly compare?: boolean;
  readonly signal?: AbortSignal;
}

export interface ReplayResult {
  /** The run redone. */
  readonly result: RunResult;
  /** What does not match, or what changed in the meantime. */
  readonly warnings: ReplayWarning[];
  /** `true` if the replay trace matches the original one, modulo time. */
  readonly equal: boolean;
}

/**
 * Redoes a run from a trace.
 *
 * @param source the trace, or its JSONL.
 */
export async function replay(
  source: Trace | string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const original = typeof source === 'string' ? Trace.parse(source) : source;
  const mode = options.mode ?? 'full';
  const start = original.of('run.start')[0];
  if (start === undefined) {
    throw new ReplayMismatchError(0, 'the trace does not contain a run.start: it is not a run trace');
  }

  const warnings = diffTools(original, options.tools);
  const registry = buildRegistry(original, options.tools, mode, warnings);

  const policy = recordedPolicy(original);
  const runOptions: RunOptions = {
    policy,
    messages: start.messages,
    tools: registry,
    // the same parameters as the original run: a replay with a different cap would
    // stop at a different step and would not be comparing the same thing
    budget: new Budget(start.parameters.budgetLimit as never),
    maxSteps: start.parameters.maxSteps,
    stepAllowance: start.parameters.stepAllowance as never,
    // the price is the one **resolved** in the original run: recomputing it with a
    // different table would change the spend and the replay would stop at a different step
    prices: { [policy.model]: start.parameters.price as Price },
    trace: new Trace(),
    // same runId as the original run: the replay *is* that run, not a new one.
    // the provenance of the replay lives in ReplayResult, not inside the trace.
    runId: start.runId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const result = await run(runOptions);
  const equal = options.compare === false ? false : sameTrace(original, result.trace);
  return { result, warnings, equal };
}

/**
 * A `Policy` that answers with the recorded decisions.
 *
 * It fails if the trace ends early: it means the replay is asking for one more
 * decision than the original run had taken, which is a loop bug or a truncated trace.
 * Either way, saying it now is worth more than inventing an answer.
 */
function recordedPolicy(original: Trace): Policy {
  const responses = original.of('policy.response');
  let index = 0;
  return {
    // the model is that of the first recorded response: the price needs it
    model: responses[0]?.model ?? 'recorded',
    decide: (): Promise<PolicyOutcome> => {
      const response = responses[index++];
      if (response === undefined) {
        return Promise.reject(
          new ReplayMismatchError(
            index - 1,
            `the trace has ${responses.length} responses but the replay asked for ${index}: the loop changed`,
          ),
        );
      }
      return Promise.resolve({
        decision: response.decision,
        usage: response.usage,
        model: response.model,
      });
    },
  };
}

/**
 * The registry to use during replay.
 *
 * In `live-tools` it is the real registry and that is the end of it. Otherwise every
 * tool is replaced by one that returns what had been recorded, or that **throws** the
 * recorded error when the original run had failed: that is how the model's
 * self-correction loop is reproduced, instead of reproducing only the happy case.
 */
function buildRegistry(
  original: Trace,
  real: ToolRegistry | undefined,
  mode: ReplayMode,
  warnings: ReplayWarning[],
): ToolRegistry {
  if (mode === 'live-tools') {
    if (real === undefined) {
      throw new TypeError('live-tools mode requires the real tools: without them it is not a replay');
    }
    return real;
  }

  const results = new Map<string, ToolOutcomeTrace>();
  for (const event of original.of('tool.result')) {
    // if a tool was called more than once, the last result is not enough:
    // it is accepted and stated, because a wrong reconstruction is worse than none
    results.set(`${event.step}/${event.tool}`, event.outcome);
  }

  const fake = new ToolRegistry();
  for (const event of original.of('tool.call')) {
    const name = event.call.name;
    if (fake.has(name)) continue; // one tool per name: the schema cannot change mid-run

    // if a tool was called more than once, the first recorded outcome is used:
    // it is not the exact reconstruction, and that is why the fingerprint in the
    // tool comparison says when the replay is no longer trustworthy
    const outcome = results.get(`${event.step}/${name}`) ?? firstForTool(results, name);
    const spec = real?.get(name);

    const reconstructed: AnyTool = {
      name,
      description: spec?.description ?? `tool ${name} reconstructed from the trace`,
      schema: spec?.schema ?? { type: 'object' },
      execute: (): unknown => {
        if (outcome === undefined) {
          // no recorded outcome: the neutral failure is reproduced, which is
          // what the model had actually seen
          throw new ReplayedFailure({
            kind: 'execution_failed',
            message:
              `Tool "${name}" failed with an internal error (see the trace for the cause). ` +
              `Do not retry more than once with the same arguments; if it fails again, ` +
              `tell the user and propose an alternative path.`,
          });
        }
        if (!outcome.ok) throw new ReplayedFailure(outcome.failure);
        return outcome.output;
      },
    };

    try {
      fake.add(reconstructed);
    } catch (error) {
      // a schema that is no longer supported must not make the replay fail: it is recorded
      warnings.push({
        kind: 'tool_changed',
        tool: name,
        message: `could not reconstruct tool "${name}": ${String(error)}`,
      });
    }
  }

  return fake;
}

/** The first recorded outcome for a tool, at any step. */
function firstForTool(results: ReadonlyMap<string, ToolOutcomeTrace>, name: string): ToolOutcomeTrace | undefined {
  for (const [key, outcome] of results) {
    if (key.endsWith(`/${name}`)) return outcome;
  }
  return undefined;
}

/**
 * Compares the tools recorded in the trace with those available now.
 *
 * This is where a trace that lies unmasks itself (ADR 0003): if a tool's code changed,
 * the recorded results no longer describe its behavior and replay must say so instead
 * of pretending everything went fine.
 */
function diffTools(original: Trace, real: ToolRegistry | undefined): ReplayWarning[] {
  const warnings: ReplayWarning[] = [];
  if (real === undefined) return warnings;

  const recorded = new Map<string, string | undefined>();
  for (const event of original.of('tool.call')) {
    recorded.set(event.call.name, event.fingerprint);
  }

  for (const [name, fingerprint] of recorded) {
    const current = real.fingerprint(name);
    if (current === undefined) {
      warnings.push({
        kind: 'tool_missing',
        tool: name,
        message: `tool "${name}" is in the trace but is not registered`,
      });
      continue;
    }
    if (fingerprint !== undefined && fingerprint !== current) {
      warnings.push({
        kind: 'tool_changed',
        tool: name,
        message:
          `tool "${name}" changed since the recorded run (fingerprint ${fingerprint} → ${current}): ` +
          `the result in the trace may no longer describe its behavior`,
      });
    }
  }

  for (const name of real.names()) {
    if (!recorded.has(name)) {
      warnings.push({
        kind: 'extra_tool',
        tool: name,
        message: `tool "${name}" exists now but was not used in the recorded run`,
      });
    }
  }

  return warnings;
}

/** Two traces are the same run if they match modulo time. */
function sameTrace(a: Trace, b: Trace): boolean {
  const left = a.normalized();
  const right = b.normalized();
  return left.length === right.length && left.every((event, i) => JSON.stringify(event) === JSON.stringify(right[i]));
}
