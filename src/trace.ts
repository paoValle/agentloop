/**
 * The trace: the append-only log of a run.
 *
 * It is not a log file. A log says "what happened" in a readable format; the trace
 * says "what happened" in a format that can be **read back and asserted on in a test**
 * (ADR 0001). That is why every event is a JSON value with no stacked fields and no
 * mandatory timestamps: two executions of the same conversation produce identical
 * traces except for time.
 *
 * Three problems a naïve trace gets wrong, and how they are solved here:
 *
 * - **personal data ends up in the trace.** A tool that reads a user profile writes
 *   what it read into the log. Tools that do that declare themselves `sensitive` and
 *   their arguments and results are redacted: the size stays, the content does not.
 * - **a non-serializable output blows up logging.** A tool may return a class, a
 *   `Map`, or something with a cycle. `toTraceable` never fails: it degrades and says
 *   that it degraded.
 * - **a huge output blows up the file.** Truncation with the exact count of what was
 *   cut, because a trace that lies while looking complete is worse than a missing one.
 */

import type { Decision, Message, StopReason, ToolCall, ToolFailure, Usage } from './types.js';

/** Fields common to every event. */
interface TraceBase {
  /** Position in the trace. Monotonic, gap-free: a hole means a loss. */
  readonly seq: number;
  /** Unix ms. Present for analysis, **ignored** by the replay comparison. */
  readonly ts: number;
}

/** The parameters that determine a run: without them, the trace is not enough to redo it. */
export interface RunParameters {
  /** Spending cap, in µUSD. */
  readonly budgetLimit: number;
  /** Step cap. */
  readonly maxSteps: number;
  /** Estimate the first step starts from, in µUSD. */
  readonly stepAllowance: number;
  /**
   * The price **resolved** for this run's model, in µUSD per million tokens.
   *
   * The effective price is recorded, not the table: it is what determined the spend,
   * and a replay that recomputed with different prices would produce a different
   * spend and stop at a different step.
   */
  readonly price: { readonly input: number; readonly output: number };
}

/** Every event a run can produce. */
export type TraceEvent =
  | (TraceBase & {
      type: 'run.start';
      runId: string;
      messages: readonly Message[];
      tools: readonly string[];
      parameters: RunParameters;
    })
  | (TraceBase & { type: 'step.start'; step: number })
  | (TraceBase & { type: 'policy.request'; step: number; model: string; messageCount: number })
  | (TraceBase & { type: 'policy.response'; step: number; model: string; usage: Usage; decision: Decision })
  | (TraceBase & { type: 'tool.call'; step: number; call: TraceableToolCall; sensitive: boolean; fingerprint?: string })
  | (TraceBase & { type: 'tool.result'; step: number; callId: string; tool: string; outcome: ToolOutcomeTrace })
  | (TraceBase & { type: 'budget.settle'; step: number; reserved: number; actual: number })
  | (TraceBase & { type: 'run.end'; steps: number; stopReason: StopReason; spent: number; spentUsd: string });

/** A tool call, with arguments already run through `toTraceable`. */
export interface TraceableToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** Outcome of a tool, in traceable form. */
export type ToolOutcomeTrace =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly failure: ToolFailure };

/** How a value we decided not to write looks. */
export interface Redacted {
  readonly redacted: true;
  /** Estimated bytes of the original value: it tells how big it was. */
  readonly bytes: number;
}

/** How a truncated value looks. */
export interface Truncated {
  readonly truncated: true;
  readonly bytes: number;
  readonly keptBytes: number;
}

/**
 * `Omit` distributed over unions.
 *
 * TypeScript's `Omit` applied to a union does **not** distribute: it applies to the
 * union as a whole and deletes the keys that are not common to every variant.
 * `Omit<TraceEvent, 'seq' | 'ts'>` would become `{ type: string }` and
 * `append({ type: 'step.start', step: 0 })` would not compile. Here every variant
 * loses its own two fields and the other keys stay intact.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** An event as the caller provides it: without `seq`, which the trace assigns. */
export type TraceInput = DistributiveOmit<TraceEvent, 'seq' | 'ts'>;

/** Threshold above which a value is cut. 64 KiB: plenty for a tool. */
export const MAX_TRACE_VALUE_BYTES = 64 * 1024;

/**
 * Converts any value into something JSON-writable, never failing.
 *
 * An `Error` becomes `{ name, message }`: the rest of the stack is noise for the
 * trace and often contains absolute paths. Non-serializable values become their
 * type description, marked as degraded.
 */
export function toTraceable(value: unknown): unknown {
  return encode(value, new WeakSet(), 0);
}

function encode(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { degraded: `number: ${String(value)}` };
  }
  if (typeof value === 'bigint') return { degraded: `bigint: ${value.toString()}` };
  if (typeof value === 'function') return { degraded: `function: ${value.name === '' ? 'anonymous' : value.name}` };
  if (typeof value === 'symbol') return { degraded: `symbol: ${value.description ?? 'no description'}` };

  const object: object = value;
  if (seen.has(object)) return { degraded: 'cycle' };
  if (depth > 12) return { degraded: 'maximum depth' };

  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, seen, depth + 1));

    if (value instanceof Map) {
      return { degraded: `Map(${value.size})` };
    }
    if (value instanceof Set) {
      return { degraded: `Set(${value.size})` };
    }
    if (value instanceof Date) return value.toISOString();

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encode(item, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Applies redaction to a value, returning only its size. */
export function redact(value: unknown): Redacted {
  let bytes = 0;
  try {
    bytes = JSON.stringify(toTraceable(value)).length;
  } catch {
    bytes = -1;
  }
  return { redacted: true, bytes };
}

/**
 * Prepares a value for the trace: redaction when requested, truncation when big.
 *
 * The two checks are in this order because a redacted value must not be truncated:
 * saying "this was huge" is a useful fact, saying it halfway is not.
 */
export function prepareForTrace(
  value: unknown,
  options: { sensitive: boolean },
): unknown {
  if (options.sensitive) return redact(value);

  const safe = toTraceable(value);
  let json: string;
  try {
    json = JSON.stringify(safe);
  } catch {
    return { degraded: 'not serializable' };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= MAX_TRACE_VALUE_BYTES) return safe;

  return { ...(safe as Record<string, unknown>), __truncated: { truncated: true, bytes, keptBytes: MAX_TRACE_VALUE_BYTES } satisfies Truncated };
}

/**
 * The append-only log.
 *
 * "Append-only" is a structural property, not a promise: only `append` exists,
 * neither `remove` nor `update` do. A test can rearrange the code and end up editing
 * an existing trace only by looking for it, and it will not find it.
 */
export class Trace {
  readonly #events: TraceEvent[] = [];
  readonly #clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  /** Adds an event. The `seq` is assigned here and is not negotiable. */
  append(event: TraceInput): TraceEvent {
    const full = { ...event, seq: this.#events.length, ts: this.#clock() } as TraceEvent;
    this.#events.push(full);
    return full;
  }

  get events(): readonly TraceEvent[] {
    return this.#events;
  }

  get length(): number {
    return this.#events.length;
  }

  /** The events of one type, in order. */
  of<T extends TraceEvent['type']>(type: T): Extract<TraceEvent, { type: T }>[] {
    return this.#events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type);
  }

  /** Last event, if any. */
  get last(): TraceEvent | undefined {
    return this.#events.at(-1);
  }

  /** Serializes to JSONL: one event per line, no trailing empty line. */
  toJSONL(): string {
    return this.#events.map((event) => JSON.stringify(event)).join('\n');
  }

  /** Reads back from JSONL. A malformed line is an error, not a silent hole. */
  static parse(source: string): Trace {
    const trace = new Trace({ clock: () => 0 });
    const lines = source.split('\n').filter((line) => line.trim() !== '');
    for (const [index, line] of lines.entries()) {
      try {
        trace.#events.push(JSON.parse(line) as TraceEvent);
      } catch (error) {
        throw new SyntaxError(`trace line ${index + 1} is not valid JSON: ${String(error)}`);
      }
    }
    return trace;
  }

  /**
   * The comparable projection: two runs of the same conversation must produce
   * identical projections.
   *
   * **Two** fields are excluded, and both by construction, not for convenience:
   *
   * - `ts`: two executions have different times by definition.
   * - `tool.call.fingerprint`: during replay the tool is a **reconstruction** with a
   *   different body, so its fingerprint differs by construction. Excluding it here
   *   does not mean ignoring that the tool changed: that check is a different one, and
   *   a stricter one — it is the ADR 0003 warning, which compares the **real** tool
   *   against the recorded fingerprint and never lets it through silently.
   *
   * `seq` stays, because it marks the position and that must match.
   */
  normalized(): unknown[] {
    return this.#events.map((event) => {
      const { ts: _ts, ...rest } = event;
      if (rest.type === 'tool.call') {
        const { fingerprint: _fingerprint, ...withoutFingerprint } = rest;
        return withoutFingerprint;
      }
      return rest;
    });
  }
}

/** Builds a `TraceableToolCall` from a `ToolCall`, going through redaction. */
export function traceableCall(call: ToolCall, sensitive: boolean): TraceableToolCall {
  return { id: call.id, name: call.name, args: prepareForTrace(call.args, { sensitive }) };
}
