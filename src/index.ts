/**
 * `agentloop` — a small and readable agentic runtime.
 *
 * Four things, and nothing else:
 *
 * - a declarative **loop**, where every effect goes through an interface;
 * - **tools** with arguments validated by JSON Schema, that fail without hurting;
 * - a **budget** that is reserved before spending and cannot be bypassed;
 * - an append-only **trace** from which the run can be **replayed** with no network.
 *
 * ```ts
 * const result = await run({
 *   policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
 *   tools: new ToolRegistry([searchFlights]),
 *   messages: [{ role: 'user', content: 'cheapest flight Naples-Rome' }],
 *   budget: new Budget(usd(0.10)),
 * });
 * ```
 *
 * The decisions that hold all of this up are in `docs/adr/`, and they weigh as much
 * as the code: if one of them is wrong, the code is simply a consequence.
 */

export { run, resolvePrice, type PriceTable, type RunOptions, type RunResult, type Estimation } from './loop.js';
export { replay, type ReplayMode, type ReplayOptions, type ReplayResult, type ReplayWarning } from './replay.js';

export {
  Budget,
  MICRO_USD_PER_USD,
  UNKNOWN_MODEL,
  costOf,
  formatUsd,
  micros,
  usd,
  type MicroUsd,
  type Price,
} from './budget.js';

export { Trace, prepareForTrace, redact, toTraceable, traceableCall, type RunParameters, type TraceEvent, type TraceInput } from './trace.js';

export { ReplayedFailure, ToolError, ToolRegistry, invokeTool } from './tool.js';

export { assertSchemaSupported, deepEqual, describeValue, validate } from './validate.js';

export { SUPPORTED_KEYWORDS, type JsonSchema, type JsonSchemaType, type ValidationError } from './schema.js';

export {
  AgentLoopError,
  BudgetExceededError,
  PolicyError,
  ReplayMismatchError,
  SchemaViolationError,
  ToolExecutionError,
  UnknownToolError,
  UnsupportedSchemaKeywordError,
} from './errors.js';

export { interpret, openAICompatible, type OpenAICompatibleOptions } from './policy-openai.js';

export type {
  AnyTool,
  DecideRequest,
  Decision,
  Message,
  Policy,
  PolicyOutcome,
  Role,
  RunState,
  StopReason,
  Tool,
  ToolCall,
  ToolContext,
  ToolFailure,
  ToolFailureKind,
  ToolSpec,
  Usage,
} from './types.js';
