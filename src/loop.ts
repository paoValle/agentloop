/**
 * The loop.
 *
 * One step, in fixed order and with no shortcuts:
 *
 *   1. reserve the cost of the step in the budget — if it does not fit, the run ends
 *      **here**, without anyone having spent anything;
 *   2. ask the `Policy` for a decision;
 *   3. settle on the real consumption, which can be lower than the estimate;
 *   4. if the decision is a tool, validate it, execute it, and put the result into the
 *      context — success or failure, the failure is a message;
 *   5. if the decision is a message, the run is over.
 *
 * Every step emits trace events **before** the next step. The trace is not an
 * accessory written at the end: it is how the loop knows where it is (ADR 0001).
 */

import { Budget, costOf, formatUsd, micros, type MicroUsd, type Price, type PriceTable } from './budget.js';
import { BudgetExceededError, PolicyError } from './errors.js';
import { Trace, prepareForTrace, redact, traceableCall } from './trace.js';
import { ToolRegistry, invokeTool } from './tool.js';
import type { Message, Policy, PolicyOutcome, StopReason, ToolCall } from './types.js';

/** Known prices, per model. A missing model is valued worse than all of them. */
export type { PriceTable };

/**
 * How much is reserved before a step.
 *
 * The cost of a call cannot be known before making it. The first estimate is a
 * configured threshold; from the second one on it becomes the **maximum actually
 * observed** in the run. An agent that uses 800 tokens at one step and 40,000 at the
 * next stops being caught short by an average one, and the forecast stays a cap.
 */
export interface Estimation {
  /** Estimate for a step without data yet: the default is 5 ¢. */
  stepAllowance: MicroUsd;
  /** The maximum observed so far. Zero until there has been no step. */
  observedMax: MicroUsd;
}

export interface RunOptions {
  /** Who decides. It must declare its model: a budget that does not know the price is not a budget. */
  readonly policy: Policy;
  /** The initial context. Required: a run without messages makes no sense. */
  readonly messages: readonly Message[];
  /** The tools reachable by the model. By default, none. */
  readonly tools?: ToolRegistry;
  /**
   * The spending cap. **Required**.
   *
   * A run without a cap is a run that can spend as much as it likes. Making it
   * optional with a default means the default will be forgotten, and the case where it
   * is forgotten is exactly that of a loopy agent calling a paid provider. If you do
   * not need the cap, declare it: `Budget.unlimited()`.
   */
  readonly budget: Budget;
  /** Step cap. Defaults to 12: beyond that, an agent is going in circles. */
  readonly maxSteps?: number;
  /** Trace to write to. By default, a new in-memory trace. */
  readonly trace?: Trace;
  /** Prices per model. See `resolvePrice`. */
  readonly prices?: PriceTable;
  /** Initial estimate for one step. Defaults to 5 ¢. */
  readonly stepAllowance?: MicroUsd;
  /** Run identifier, to correlate logs and traces. */
  readonly runId?: string;
  /** Cancellation. It is honored at every step and passed to policy and tools. */
  readonly signal?: AbortSignal;
}

/** How a run ended. */
export interface RunResult {
  /** The full conversation, including `tool` messages. */
  readonly messages: readonly Message[];
  /** How many steps were executed. */
  readonly steps: number;
  /** Why it ended. Always set: a run that ends "who knows" is a bug. */
  readonly stopReason: StopReason;
  /** Money actually spent. */
  readonly spent: MicroUsd;
  /** The final text, if the run ended with `end_turn`. */
  readonly answer?: string;
  /** The trace. Always present, even if the run blew up. */
  readonly trace: Trace;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_STEP_ALLOWANCE = micros(50_000);

/**
 * Executes a run.
 *
 * It does not throw for *run* errors (budget exhausted, step cap, cancellation):
 * those are outcomes, and they come back inside `RunResult`. It throws only for what
 * is a bug or a failure — a `Policy` that does not answer, a malformed context.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const tools = options.tools ?? new ToolRegistry();
  const budget = options.budget;
  const trace = options.trace ?? new Trace();
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const prices = options.prices ?? {};
  // declared as `string | undefined` on purpose: `Policy.model` is required in
  // TypeScript, but a Policy can come from JavaScript or from a cast. A cap that does
  // not know the price is worse than no cap, so it is checked anyway.
  const model = options.policy.model as string | undefined;

  if (options.messages.length === 0) {
    throw new TypeError('a run needs at least one initial message');
  }
  if (model === undefined) {
    throw new TypeError('the Policy does not declare its model: without the price the budget cannot work');
  }

  const price = resolvePrice(prices, model);
  const estimation: Estimation = {
    stepAllowance: options.stepAllowance ?? DEFAULT_STEP_ALLOWANCE,
    observedMax: micros(0),
  };

  let messages: Message[] = [...options.messages];
  let stopReason: StopReason = 'max_steps';
  let steps = 0;
  let answer: string | undefined;

  trace.append({
    type: 'run.start',
    runId: options.runId ?? 'run',
    messages,
    tools: tools.names(),
    parameters: {
      budgetLimit: budget.limit,
      maxSteps,
      stepAllowance: estimation.stepAllowance,
      price,
    },
  });

  for (let step = 0; step < maxSteps; step++) {
    if (options.signal?.aborted === true) {
      stopReason = 'aborted';
      break;
    }

    steps = step + 1;
    const stepId = `step-${steps}`;
    trace.append({ type: 'step.start', step });

    const estimate = estimation.observedMax > estimation.stepAllowance ? estimation.observedMax : estimation.stepAllowance;
    let reservation;
    try {
      reservation = budget.reserve(estimate);
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      // the cap did not allow it: the run ends without anyone having spent anything
      stopReason = 'budget';
      break;
    }

    trace.append({ type: 'policy.request', step, model, messageCount: messages.length });

    let outcome: PolicyOutcome;
    try {
      outcome = await options.policy.decide({
        messages,
        tools: tools.specs(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // the reservation was not spent: it is released and the error goes up
      budget.release(reservation);
      if (error instanceof BudgetExceededError) throw error;
      throw new PolicyError(`the Policy failed at step ${step}`, { cause: error });
    }

    const actual = costOf(outcome.usage, price);
    budget.settle(reservation, actual);
    estimation.observedMax = max(estimation.observedMax, actual);

    trace.append({
      type: 'policy.response',
      step,
      model: outcome.model,
      usage: outcome.usage,
      // the decision carries the arguments the model produced: if the tool is
      // sensitive they must be redacted here too, not only in tool.call
      decision: redactedDecision(outcome.decision, tools),
    });
    trace.append({ type: 'budget.settle', step, reserved: estimate, actual });

    messages = [...messages, assistantMessage(outcome.decision)];

    if (outcome.decision.type === 'message') {
      answer = outcome.decision.content;
      stopReason = 'end_turn';
      break;
    }

    if (outcome.decision.type === 'stop') {
      stopReason = outcome.decision.reason;
      break;
    }

    messages = [...messages, ...(await runTool(tools, outcome.decision.call, step, stepId, trace, options.signal))];
  }

  trace.append({
    type: 'run.end',
    steps,
    stopReason,
    spent: budget.spent,
    spentUsd: formatUsd(budget.spent),
  });

  const result: RunResult = { messages, steps, stopReason, spent: budget.spent, trace };
  return answer === undefined ? result : { ...result, answer };
}

/**
 * Executes a tool and returns the messages to add to the context.
 *
 * Success or failure, the content goes back to the model: that is how an agent
 * self-corrects. A failure does not raise, because a failing tool is an ordinary
 * event of a run, not a runtime error.
 */
async function runTool(
  tools: ToolRegistry,
  call: ToolCall,
  step: number,
  stepId: string,
  trace: Trace,
  signal: AbortSignal | undefined,
): Promise<Message[]> {
  const tool = tools.get(call.name);
  const sensitive = tool?.sensitive === true;

  trace.append({
    type: 'tool.call',
    step,
    call: traceableCall(call, sensitive),
    sensitive,
    ...(tool === undefined ? {} : { fingerprint: tools.fingerprint(call.name) as string }),
  });

  const outcome = await invokeTool(
    tools,
    call,
    signal === undefined ? { stepId } : { stepId, signal },
  );

  trace.append({
    type: 'tool.result',
    step,
    callId: call.id,
    tool: call.name,
    outcome: outcome.ok
      ? { ok: true, output: prepareForTrace(outcome.output, { sensitive }) }
      : { ok: false, failure: outcome.failure },
  });

  if (outcome.ok) {
    return [
      { role: 'tool', tool_call_id: call.id, name: call.name, content: asContent(outcome.output) },
    ];
  }
  return [
    { role: 'tool', tool_call_id: call.id, name: call.name, content: `ERROR: ${outcome.failure.message}` },
  ];
}

/**
 * The decision as it goes into the trace.
 *
 * A tool decision carries its arguments, and those arguments can be personal data.
 * Redacting them only in `tool.call` is not enough: they would end up in
 * `policy.response`, which is written one line earlier and ends up in the same files
 * that end up in backups.
 */
function redactedDecision(decision: PolicyOutcome['decision'], tools: ToolRegistry): PolicyOutcome['decision'] {
  if (decision.type !== 'tool') return decision;
  const sensitive = tools.get(decision.call.name)?.sensitive === true;
  if (!sensitive) return decision;
  return {
    type: 'tool',
    call: { id: decision.call.id, name: decision.call.name, args: redact(decision.call.args) },
  };
}

/** The `assistant` message that corresponds to a decision. */
function assistantMessage(decision: PolicyOutcome['decision']): Message {
  if (decision.type === 'message') return { role: 'assistant', content: decision.content };
  if (decision.type === 'stop') return { role: 'assistant', content: `[stop: ${decision.reason}]` };
  return {
    role: 'assistant',
    content: `[tool: ${decision.call.name}] ${JSON.stringify(decision.call.args ?? {})}`,
  };
}

/** How a tool output is rendered into the context: almost always JSON, never `undefined`. */
function asContent(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined) return '(no result)';
  try {
    // annotated as `string | undefined` because at runtime it can be:
    // `JSON.stringify` returns `undefined` for a function or a symbol
    const serialized: unknown = JSON.stringify(output);
    return typeof serialized === 'string' ? serialized : '(result not serializable)';
  } catch {
    return '(result not serializable)';
  }
}

/**
 * The price of a model.
 *
 * A model missing from the table is valued at the **highest** known price, not at
 * zero. The reason: `UNKNOWN_MODEL = 0` makes the budget look like it protects
 * something while it protects nothing, and a new model entering production is exactly
 * the moment when you do not want the cap to vanish. Being pessimistic costs one more
 * step; being optimistic costs real money.
 */
export function resolvePrice(prices: PriceTable, model: string): Price {
  const found = prices[model];
  if (found !== undefined) return found;

  const entries = Object.values(prices);
  if (entries.length === 0) return { input: micros(0), output: micros(0) };
  return {
    input: Math.max(...entries.map((p) => p.input)) as MicroUsd,
    output: Math.max(...entries.map((p) => p.output)) as MicroUsd,
  };
}

function max(a: MicroUsd, b: MicroUsd): MicroUsd {
  return a > b ? a : b;
}
