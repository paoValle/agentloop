/**
 * Typed errors.
 *
 * Every error the runtime can produce has a type: `catch (e) { }` should not
 * require reading the message to understand what happened.
 */

import type { ValidationError } from './schema.js';

/** Base of everything that can fail inside the runtime. */
export class AgentLoopError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The money budget no longer covers the call.
 *
 * This is not an error "to handle": it is the budget working correctly. The loop
 * catches it, closes the run with `stopReason: 'budget'` and returns a result
 * — it only becomes an exception if someone uses it directly outside the loop.
 */
export class BudgetExceededError extends AgentLoopError {
  readonly requested: number;
  readonly available: number;

  constructor(requested: number, available: number) {
    super(`insufficient budget: ${requested} µUSD needed, ${available} µUSD available`);
    this.requested = requested;
    this.available = available;
  }
}

/** The arguments produced by the model do not match the tool schema. */
export class SchemaViolationError extends AgentLoopError {
  readonly errors: readonly ValidationError[];

  constructor(tool: string, errors: readonly ValidationError[]) {
    super(`invalid arguments for tool "${tool}"`, { cause: errors });
    this.errors = errors;
  }
}

/** The model called a tool that is not registered. */
export class UnknownToolError extends AgentLoopError {
  constructor(
    readonly requested: string,
    readonly available: readonly string[],
  ) {
    super(
      `unknown tool "${requested}". Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
    );
  }
}

/** The tool exists, received valid arguments, and failed anyway. */
export class ToolExecutionError extends AgentLoopError {
  constructor(
    readonly tool: string,
    options?: { cause?: unknown },
  ) {
    super(`tool "${tool}" failed`, options);
  }
}

/** The `Policy` failed: network, rate limit, unexpected response shape. */
export class PolicyError extends AgentLoopError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The schema contains a keyword that this validator does **not support**.
 *
 * This is a development error, not an input error: it must blow up when the schema
 * is registered, not when a user passes a weird argument. See ADR 0002.
 */
export class UnsupportedSchemaKeywordError extends AgentLoopError {
  constructor(
    readonly keyword: string,
    readonly path: string,
  ) {
    super(
      `unsupported JSON Schema keyword: "${keyword}" at ${path}. ` +
        `See docs/adr/0002-json-schema-validator.md for the supported subset.`,
    );
  }
}

/**
 * Replay does not match the trace: the expected event differs from the recorded one.
 *
 * It means the loop was changed in a way that invalidates reproduction.
 * It is not "fixed": it is understood.
 */
export class ReplayMismatchError extends AgentLoopError {
  constructor(
    readonly step: number,
    message: string,
  ) {
    super(message);
  }
}
