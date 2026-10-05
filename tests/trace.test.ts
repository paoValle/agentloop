import { describe, expect, it } from 'vitest';

import {
  MAX_TRACE_VALUE_BYTES,
  Trace,
  prepareForTrace,
  redact,
  toTraceable,
  traceableCall,
} from '../src/trace.js';

const fixed = (): Trace => new Trace({ clock: () => 1_700_000_000_000 });

const parameters = { budgetLimit: 1_000_000, maxSteps: 12, stepAllowance: 50_000, price: { input: 3, output: 15 } };

describe('toTraceable: it must never fail', () => {
  it('passes simple values through', () => {
    expect(toTraceable({ a: 1, b: 'x', c: [true, null] })).toEqual({ a: 1, b: 'x', c: [true, null] });
  });

  it('an Error becomes name and message, not a stack with absolute paths', () => {
    expect(toTraceable(new TypeError('not a number'))).toEqual({
      name: 'TypeError',
      message: 'not a number',
    });
  });

  it('a cycle does not recurse forever', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.itself = cyclic;
    expect(toTraceable(cyclic)).toMatchObject({ name: 'x', itself: { degraded: 'cycle' } });
  });

  it('degrades what makes no sense to serialize', () => {
    expect(toTraceable(Number.NaN)).toEqual({ degraded: 'number: NaN' });
    expect(toTraceable(10n)).toEqual({ degraded: 'bigint: 10' });
    expect(toTraceable(new Map([['a', 1]]))).toEqual({ degraded: 'Map(1)' });
    expect(toTraceable(new Set([1]))).toEqual({ degraded: 'Set(1)' });
    expect(toTraceable(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toTraceable(() => undefined)).toEqual({ degraded: 'function: anonymous' });
  });

  it('cuts the depth instead of descending into hell', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 30; i++) deep = { below: deep };
    expect(JSON.stringify(toTraceable(deep))).toContain('maximum depth');
  });

  it('the same object appearing twice does not become a false cycle', () => {
    const shared = { k: 1 };
    expect(toTraceable({ a: shared, b: shared })).toEqual({ a: { k: 1 }, b: { k: 1 } });
  });
});

describe('redaction', () => {
  it('a sensitive tool does not write the content, but says how big it was', () => {
    const patient = { name: 'Mario Rossi', email: 'mario@example.com' };
    expect(redact(patient)).toEqual({ redacted: true, bytes: JSON.stringify(patient).length });
  });

  it('the redacted content is really gone', () => {
    const written = JSON.stringify(prepareForTrace({ email: 'mario@example.com' }, { sensitive: true }));
    expect(written).not.toContain('mario@example.com');
    expect(written).toContain('"redacted":true');
  });
});

describe('truncation', () => {
  it('below the threshold it is left alone', () => {
    expect(prepareForTrace({ small: 1 }, { sensitive: false })).toEqual({ small: 1 });
  });

  it('above the threshold it declares what was cut', () => {
    const huge = { data: 'x'.repeat(MAX_TRACE_VALUE_BYTES * 2) };
    const out = prepareForTrace(huge, { sensitive: false }) as Record<string, unknown>;
    expect(out.__truncated).toMatchObject({ truncated: true });
    expect((out.__truncated as { bytes: number }).bytes).toBeGreaterThan(MAX_TRACE_VALUE_BYTES);
  });

  it('a redacted value is not truncated: its size is already a useful fact', () => {
    const huge = 'x'.repeat(MAX_TRACE_VALUE_BYTES * 2);
    const out = prepareForTrace(huge, { sensitive: true });
    expect(out).toMatchObject({ redacted: true });
    expect(out).not.toHaveProperty('__truncated');
  });
});

describe('Trace', () => {
  it('assigns monotonic, gap-free seq values', () => {
    const trace = fixed();
    trace.append({ type: 'run.start', runId: 'r1', messages: [], tools: [], parameters });
    trace.append({ type: 'step.start', step: 0 });
    trace.append({ type: 'step.start', step: 1 });
    expect(trace.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('filters by type, keeping the order', () => {
    const trace = fixed();
    trace.append({ type: 'step.start', step: 0 });
    trace.append({ type: 'policy.request', step: 0, model: 'm', messageCount: 1 });
    trace.append({ type: 'step.start', step: 1 });
    expect(trace.of('step.start').map((e) => e.step)).toEqual([0, 1]);
  });

  it('JSONL: one line per event, and the way back to the identical thing', () => {
    const trace = fixed();
    trace.append({ type: 'run.start', runId: 'r1', messages: [{ role: 'user', content: 'hello' }], tools: ['a'], parameters });
    trace.append({ type: 'run.end', steps: 0, stopReason: 'end_turn', spent: 0, spentUsd: '0.000000' });

    const lines = trace.toJSONL().split('\n');
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1] as string) as { type: string; stopReason?: string };
    expect(second.stopReason).toBe('end_turn');

    const reread = Trace.parse(trace.toJSONL());
    expect(reread.normalized()).toEqual(trace.normalized());
  });

  it('a malformed line is an error, not a silent hole', () => {
    const trace = fixed();
    trace.append({ type: 'run.start', runId: 'r1', messages: [], tools: [], parameters });
    expect(() => Trace.parse(`${trace.toJSONL()}\n{broken`)).toThrow(SyntaxError);
    expect(() => Trace.parse(`${trace.toJSONL()}\n{broken`)).toThrow(/line 2/);
  });

  it('tolerates an empty line at the end', () => {
    expect(Trace.parse('{"seq":0,"ts":0,"type":"step.start","step":0}\n\n').length).toBe(1);
  });

  it('normalized() removes the time but keeps the position', () => {
    const a = fixed();
    a.append({ type: 'step.start', step: 0 });
    const b = new Trace({ clock: () => 999 });
    b.append({ type: 'step.start', step: 0 });
    expect(a.normalized()).toEqual(b.normalized());
    expect(a.normalized()).not.toEqual(b.events);
  });

  it('a deterministic clock makes two traces identical byte for byte', () => {
    const build = (): Trace => {
      const t = fixed();
      t.append({ type: 'step.start', step: 0 });
      return t;
    };
    expect(build().toJSONL()).toBe(build().toJSONL());
  });
});

describe('traceableCall', () => {
  it('the arguments of a sensitive tool never reach the trace', () => {
    const call = traceableCall({ id: 'c1', name: 'read_patient', args: { ssn: 'RSSMRA80A01H501U' } }, true);
    expect(call.args).toEqual({ redacted: true, bytes: JSON.stringify({ ssn: 'RSSMRA80A01H501U' }).length });
    expect(JSON.stringify(call)).not.toContain('RSSMRA80A01H501U');
  });

  it('a normal tool writes the arguments whole', () => {
    const call = traceableCall({ id: 'c1', name: 'sum', args: { a: 1 } }, false);
    expect(call.args).toEqual({ a: 1 });
  });
});
