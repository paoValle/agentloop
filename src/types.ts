/**
 * The types that flow through the whole runtime.
 *
 * They are deliberately **readonly**: run state is never mutated, it is replaced
 * (see ADR 0001). A mutable field in here is a bug waiting to happen.
 */

/** Role of a message in the conversation. The names are those of the OpenAI chat format. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A conversation message. The optional fields only apply where they are needed. */
export interface Message {
  readonly role: Role;
  readonly content: string;
  /** Present only on `role: 'tool'`: which call this answers. */
  readonly tool_call_id?: string;
  /** Present only on `role: 'tool'`: which tool produced this content. */
  readonly name?: string;
}

/** A request to execute a tool, exactly as it comes out of the model. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Not validated: `args` is whatever the model produced, and it must be checked. */
  readonly args: unknown;
}

/** Tokens consumed by a single call to the provider. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Why the loop stopped. Always explicit: a `stop` without a reason is a bug. */
export type StopReason =
  /** the model answered with a final message */
  | 'end_turn'
  /** the allowed number of steps ran out */
  | 'max_steps'
  /** the money budget did not allow it */
  | 'budget'
  /** someone called `abort()` */
  | 'aborted';

/** What the model decided at one step. */
export type Decision =
  | { readonly type: 'message'; readonly content: string }
  | { readonly type: 'tool'; readonly call: ToolCall }
  | { readonly type: 'stop'; readonly reason: StopReason };

/** Outcome of a decision: the choice **and** what it cost. */
export interface PolicyOutcome {
  readonly decision: Decision;
  readonly usage: Usage;
  /** The model that answered. It determines the price, so the budget needs it. */
  readonly model: string;
}

/** What the model sees: the description of a tool, not its code. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: import('./schema.js').JsonSchema;
}

/** What a tool may use from the outside world while it runs. */
export interface ToolContext {
  /** Cancellation signal propagated by the caller. */
  readonly signal?: AbortSignal;
  /** Identifier of the current step, for logs and correlation. */
  readonly stepId: string;
}

/**
 * A tool: name, input contract (JSON Schema), and the code that executes it.
 *
 * `I` and `O` are for the TypeScript caller. They do **not** replace validation:
 * the schema is the runtime guarantee, the generics are compile-time convenience.
 */
export interface Tool<I = unknown, O = unknown> extends ToolSpec {
  execute(input: I, ctx: ToolContext): Promise<O> | O;
  /**
   * If `true`, arguments and result go into the trace **redacted**: only the size
   * is written instead of the values. Needed when a tool touches personal data.
   */
  readonly sensitive?: boolean;
}

/**
 * A tool with erased argument types: this is what the registry can hold.
 *
 * Using `never` as the input parameter is the trick that makes the registry
 * compatible with typed tools. In TypeScript parameters are in a contravariant
 * position: `Tool<{a: number}, number>` is not assignable to a registry that wants
 * `Tool<unknown, unknown>`, because `execute` would accept anything. With `never`
 * consistency comes back, because `never` is assignable to every type: the registry
 * gives up knowing what the arguments are, which is exactly its job — the guarantee
 * comes from the schema, at runtime, where it matters.
 */
export type AnyTool = Tool<never, unknown>;

/** The brain: who decides, at every step. */
export interface Policy {
  /**
   * The model that will be queried.
   *
   * **Required.** The price is what turns a token counter into a spending cap, and
   * without knowing which model answers, the budget cannot do its job. A Policy that
   * does not declare it is a bug, not an edge case.
   */
  readonly model: string;
  decide(request: DecideRequest): Promise<PolicyOutcome>;
}

/** Everything a `Policy` knows about the world when it has to decide. */
export interface DecideRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly signal?: AbortSignal;
}

/** The reason a tool returned an error to the model. */
export type ToolFailureKind =
  /** the arguments do not match the schema */
  | 'invalid_arguments'
  /** the model asked for a tool that does not exist */
  | 'unknown_tool'
  /** the tool blew up */
  | 'execution_failed';

/** What the loop puts into `role: 'tool'` when the tool fails. */
export interface ToolFailure {
  readonly kind: ToolFailureKind;
  /** Plain message, written so a model can read it and fix itself. */
  readonly message: string;
  /** Structured detail, for the caller and for the trace. */
  readonly detail?: unknown;
}

/** A single step of the run, from the Policy's point of view. */
export interface RunState {
  readonly step: number;
  readonly messages: readonly Message[];
  readonly stopReason?: StopReason;
}
