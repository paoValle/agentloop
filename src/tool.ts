/**
 * The tool registry: who exists, under which contract, and what it is called.
 *
 * A tool is the surface a model can touch. It is where a model gets things wrong the
 * most and where a mistake costs the most, so everything that can be checked **on the
 * way in** is checked on the way in: unsupported schema, unusable name, empty
 * description, duplicates. A registration error is a development bug and must stop
 * the process immediately.
 */

import { createHash } from 'node:crypto';

import { SchemaViolationError } from './errors.js';
import { assertSchemaSupported, describeTypes, validate } from './validate.js';
import type { JsonSchema, ValidationError } from './schema.js';
import type { AnyTool, ToolCall, ToolContext, ToolFailure, ToolSpec } from './types.js';

/**
 * The error a tool author writes **to be read by the model**.
 *
 * If your tool can fail for a reason the model can understand and fix, throw
 * `ToolError` with a plain message. Any other error is reduced to a neutral message
 * by the runtime (see ADR 0004).
 */
export class ToolError extends Error {
  constructor(
    message: string,
    /** `true` if retrying the same arguments has a chance of working. */
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

/** A tool that succeeded, or the reason why it did not. */
export type ToolOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly failure: ToolFailure };

/**
 * Tool names become function names in generated code and in logs.
 * Restricting them is free and removes a class of problems: names with spaces,
 * with dots, or starting with a digit.
 */
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** The registered tools, indexed by name. */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();

  constructor(tools: readonly AnyTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  /** Registers a tool. Returns `this`, so it can be chained while building. */
  add(tool: AnyTool): this {
    const { name, description, schema } = tool;

    if (!TOOL_NAME.test(name)) {
      throw new TypeError(
        `invalid tool name: "${name}". Expected letters, digits and underscores, ` +
          `not starting with a digit, at most 64 characters.`,
      );
    }
    if (description.trim() === '') {
      throw new TypeError(`tool "${name}" has an empty description: the model has nothing to go on`);
    }
    if (this.#tools.has(name)) {
      throw new Error(`duplicate tool: "${name}" is already registered`);
    }

    // before the tool becomes reachable: a schema with an unsupported keyword must
    // stop startup, not fail at runtime on a real input
    assertSchemaSupported(schema);

    this.#tools.set(name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  get size(): number {
    return this.#tools.size;
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  /** The descriptions to send to the model. Contains no executable code. */
  specs(): ToolSpec[] {
    return this.names().map((name) => {
      const { description, schema } = this.#tools.get(name) as AnyTool;
      return { name, description, schema };
    });
  }

  /**
   * Fingerprint of a tool's code: name, description, schema and the source of the
   * `execute` function.
   *
   * Used by replay (ADR 0003): if the tool changed, the recorded results no longer
   * describe its behavior, and replay must say so instead of pretending.
   *
   * Known limit: it covers the function body, not the helpers it imports. A change
   * inside a helper does not invalidate the trace. That is accepted: the cost of
   * hashing the import graph ends up higher than the benefit.
   */
  fingerprint(name: string): string | undefined {
    const tool = this.#tools.get(name);
    if (tool === undefined) return undefined;
    return createHash('sha256')
      .update(name)
      .update('\0')
      .update(tool.description)
      .update('\0')
      .update(JSON.stringify(tool.schema))
      .update('\0')
      .update(tool.execute.toString())
      .digest('hex')
      .slice(0, 16);
  }
}

/**
 * Calls a tool through every check, and **never throws**.
 *
 * Every failure becomes a `ToolFailure` with a message written so a model reads it
 * and fixes itself. An exception escaping from here towards the loop would mean an
 * agent blew up the process: a tool failure is an ordinary run event, not an incident.
 */
export async function invokeTool(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const tool = registry.get(call.name);
  if (tool === undefined) {
    return {
      ok: false,
      failure: {
        kind: 'unknown_tool',
        message: unknownToolMessage(call.name, registry.names()),
      },
    };
  }

  const errors = validate(tool.schema, call.args);
  if (errors.length > 0) {
    return {
      ok: false,
      failure: {
        kind: 'invalid_arguments',
        message: invalidArgumentsMessage(tool.name, errors),
        detail: errors,
      },
    };
  }

  try {
    const output = await tool.execute(call.args as never, ctx);
    return { ok: true, output };
  } catch (error) {
    if (ctx.signal?.aborted === true) {
      // cancellation: not a tool error, and the loop must not self-correct
      throw error;
    }
    return { ok: false, failure: describeFailure(tool.name, error) };
  }
}

/**
 * Internal error: the message to put back into the context is **already decided**.
 *
 * Only used by replay (ADR 0003). A tool that in the original run failed with an
 * internal error already produced a neutral message; to redo the same run you cannot
 * re-execute the tool code and rebuild the error, so the whole `ToolFailure` —
 * message and `detail` — is kept and re-injected. It is not a `ToolError`: its
 * description would go through the ADR 0004 rule, add the retry suffix and lose the
 * `detail`.
 *
 * @internal
 */
export class ReplayedFailure extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.message);
    this.name = 'ReplayedFailure';
  }
}

/** Turns an exception into a `ToolFailure`, applying ADR 0004. */
function describeFailure(tool: string, error: unknown): ToolFailure {
  // first of all: replay reproduces the failure already decided, structure included
  if (error instanceof ReplayedFailure) {
    return error.failure;
  }

  if (error instanceof ToolError) {
    const retry = error.retryable
      ? 'You can retry with the same arguments.'
      : 'Fix the cause before retrying.';
    return { kind: 'execution_failed', message: `${error.message} ${retry}`, detail: { retryable: error.retryable } };
  }

  // unexpected error: nothing of the content is shown to the model, only a
  // reference. The real cause is in the trace.
  return {
    kind: 'execution_failed',
    message:
      `Tool "${tool}" failed with an internal error (see the trace for the cause). ` +
      `Do not retry more than once with the same arguments; if it fails again, ` +
      `tell the user and propose an alternative path.`,
  };
}

/**
 * The message for a set of validation errors.
 *
 * Format chosen so the model can **quote the field** and know what to fix: a flat
 * message ("invalid input") gives it nothing to work with, and the self-correction
 * loop gets longer.
 */
export function invalidArgumentsMessage(tool: string, errors: readonly ValidationError[]): string {
  const lines = errors
    .map((error) => `  - ${error.path === '' ? '<arguments>' : error.path}: ${error.message}`)
    .join('\n');
  return (
    `The arguments for "${tool}" are not valid (${errors.length} problems):\n${lines}\n` +
    `Fix only the fields listed and call "${tool}" again.`
  );
}

function unknownToolMessage(requested: string, available: readonly string[]): string {
  const list = available.length > 0 ? available.join(', ') : '(no registered tools)';
  return (
    `Tool "${requested}" does not exist. The available tools are: ${list}. ` +
    `Use only these names.`
  );
}

/** Builds a `SchemaViolationError` from the errors: for whoever prefers the exception. */
export function schemaViolation(tool: string, errors: readonly ValidationError[]): SchemaViolationError {
  return new SchemaViolationError(tool, errors);
}

/** Renders a schema in one readable line, for logs. */
export function describeSchema(schema: JsonSchema): string {
  const type = schema.type === undefined ? 'any' : describeTypes(schema.type);
  const required = schema.required === undefined ? '' : `, required: ${schema.required.join(', ')}`;
  return `${type}${required}`;
}
