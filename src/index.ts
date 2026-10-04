/**
 * `agentloop` — un runtime agentico piccolo e leggibile.
 *
 * Quattro cose, e nient'altro:
 *
 * - un **loop** dichiarativo, in cui ogni effetto passa da un'interfaccia;
 * - **tool** con argomenti validati da JSON Schema, che sbagliano senza far male;
 * - un **budget** che si prenota prima di spendere e non può essere scavalcato;
 * - una **traccia** append-only da cui il run si **rifà** senza rete.
 *
 * ```ts
 * const result = await run({
 *   policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
 *   tools: new ToolRegistry([cercaVoli]),
 *   messages: [{ role: 'user', content: ' cheapesti volo Napoli-Roma' }],
 *   budget: new Budget(usd(0.10)),
 * });
 * ```
 *
 * Le decisioni che reggono tutto questo sono in `docs/adr/`, e valgono quanto il
 * codice: se una di loro è sbagliata, il codice è semplicemente una conseguenza.
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