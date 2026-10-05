import { describe, expect, it } from 'vitest';

import { Budget, micros, usd } from '../src/budget.js';
import { PolicyError, ReplayMismatchError } from '../src/errors.js';
import { run } from '../src/loop.js';
import { replay } from '../src/replay.js';
import { Trace } from '../src/trace.js';
import { ToolRegistry, ToolError } from '../src/tool.js';
import type { Policy, PolicyOutcome, Tool } from '../src/types.js';

const start = [{ role: 'user', content: 'search for the flight to Naples' }] as const;

/** Deterministic Policy: every time it starts, it takes the same decisions. */
function script(entries: PolicyOutcome[]): Policy {
  let i = 0;
  return {
    model: 'recorded',
    decide: async () => {
      const next = entries[i++];
      if (next === undefined) throw new Error('script exhausted');
      return next;
    },
  };
}

const usage = { inputTokens: 120, outputTokens: 40 };
const msg = (content: string): PolicyOutcome => ({ decision: { type: 'message', content }, usage, model: 'recorded' });
const call = (id: string, name: string, args: unknown): PolicyOutcome => ({
  decision: { type: 'tool', call: { id, name, args } },
  usage,
  model: 'recorded',
});

let counter = 0;
const localScript = (): Policy => {
  const order = [
    call('c1', 'search_flights', { from: 'NAP', to: 'FCO' }),
    msg('The flight costs 90 euros.'),
  ];
  return script(order);
};

const searchFlights: Tool = {
  name: 'search_flights',
  description: 'Searches flights.',
  schema: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  },
  execute: () => [{ airline: 'ITA', price: 90 }],
};

const executeRun = async (tools: ToolRegistry = new ToolRegistry([searchFlights])) => {
  counter += 1;
  return run({
    policy: localScript(),
    tools,
    messages: start,
    budget: new Budget(usd(1)),
    runId: `r${counter}`,
  });
};

describe('replay: redoing the same run', () => {
  it('a run with tools is redone identically, with no network and without executing the tool', async () => {
    let executions = 0;
    const countingTool: Tool = {
      ...searchFlights,
      execute: () => {
        executions += 1;
        return [{ airline: 'ITA', price: 90 }];
      },
    };
    const first = await executeRun(new ToolRegistry([countingTool]));
    expect(executions).toBe(1);

    const { result, equal, warnings } = await replay(first.trace, {
      tools: new ToolRegistry([countingTool]),
    });

    expect(equal).toBe(true);
    expect(warnings).toEqual([]);
    expect(executions).toBe(1); // the replay did not touch the tool
    expect(result.messages).toEqual(first.messages);
    expect(result.stopReason).toBe('end_turn');
  });

  it('accepts the JSONL too: the trace is enough, the object is not needed', async () => {
    const first = await executeRun();
    const { equal } = await replay(first.trace.toJSONL(), { tools: new ToolRegistry([searchFlights]) });
    expect(equal).toBe(true);
  });

  it('the replay spend is identical to that of the original run', async () => {
    const first = await executeRun();
    const { result } = await replay(first.trace, { tools: new ToolRegistry([searchFlights]) });
    expect(result.spent).toBe(first.spent);
    expect(result.steps).toBe(first.steps);
  });

  it('the final messages are identical, not merely "similar"', async () => {
    const first = await executeRun();
    const { result } = await replay(first.trace, { tools: new ToolRegistry([searchFlights]) });
    expect(result.messages).toStrictEqual(first.messages);
    expect(result.answer).toBe(first.answer);
  });
});

describe('replay: tool failures are reproduced', () => {
  const broken: Tool = {
    name: 'search_flights',
    description: 'Searches flights.',
    schema: { type: 'object' },
    execute: () => {
      throw new ToolError('airline not available', false);
    },
  };

  it('a model self-correction loop is redone', async () => {
    const first = await run({
      policy: script([
        call('c1', 'search_flights', {}),
        call('c2', 'search_flights', {}),
        msg('I found no flights.'),
      ]),
      tools: new ToolRegistry([broken]),
      messages: start,
      budget: new Budget(usd(1)),
    });
    expect(first.messages.filter((m) => m.role === 'tool')).toHaveLength(2);

    const { result, equal } = await replay(first.trace, { tools: new ToolRegistry([broken]) });
    expect(equal).toBe(true);
    expect(result.messages).toEqual(first.messages);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('airline not available');
  });

  it('an unexpected internal error does not reappear with its text in the original run', async () => {
    const explosive: Tool = {
      name: 'search_flights',
      description: 'Searches flights.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('ECONNREFUSED to 10.1.2.3 with token sk-live-XYZ');
      },
    };
    const first = await run({
      policy: script([call('c1', 'search_flights', {}), msg('I cannot')]),
      tools: new ToolRegistry([explosive]),
      messages: start,
      budget: new Budget(usd(1)),
    });

    const { result } = await replay(first.trace, { tools: new ToolRegistry([explosive]) });
    // the replay must not rebuild the text of the real error
    expect(JSON.stringify(result.messages)).not.toContain('sk-live-XYZ');
    expect(result.messages).toEqual(first.messages);
  });
});

describe('replay: when the tool changed, it is said', () => {
  it('a modified tool produces a warning instead of a false reproduction', async () => {
    const first = await executeRun();

    const modified: Tool = {
      ...searchFlights,
      execute: () => [{ airline: 'easyJet', price: 42 }],
    };
    const { warnings } = await replay(first.trace, { tools: new ToolRegistry([modified]) });

    const warning = warnings.find((w) => w.kind === 'tool_changed');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('search_flights');
    expect(warning?.message).toContain('fingerprint');
  });

  it('in live-tools the modified tool really is re-executed, and the difference shows', async () => {
    const first = await executeRun();

    let executed = false;
    const modified: Tool = {
      ...searchFlights,
      execute: () => {
        executed = true;
        return [{ airline: 'easyJet', price: 42 }];
      },
    };
    const { result } = await replay(first.trace, {
      mode: 'live-tools',
      tools: new ToolRegistry([modified]),
    });

    expect(executed).toBe(true);
    expect(result.messages).not.toEqual(first.messages);
    expect(JSON.stringify(result.messages)).toContain('easyJet');
  });

  it('a tool that is missing is reported', async () => {
    const first = await executeRun();
    const { warnings } = await replay(first.trace, { tools: new ToolRegistry() });
    expect(warnings.map((w) => w.kind)).toContain('tool_missing');
  });

  it('a new tool that did not serve is reported as extra', async () => {
    const first = await executeRun();
    const { warnings } = await replay(first.trace, {
      tools: new ToolRegistry([searchFlights, { name: 'new', description: 'Never used.', schema: { type: 'object' }, execute: () => 1 }]),
    });
    expect(warnings.map((w) => w.kind)).toContain('extra_tool');
  });

  it('live-tools without the real tools is a programming error, not a silent replay', async () => {
    const first = await executeRun();
    await expect(replay(first.trace, { mode: 'live-tools' })).rejects.toThrow(TypeError);
  });
});

describe('replay: when it is no longer the same run', () => {
  it('a replay that asks for more decisions than the trace holds stops', async () => {
    const first = await executeRun();
    // only the first exchange is kept while maxSteps stays as it was: the loop will ask
    // for a second decision that is not in the trace, and it must say so instead of
    // inventing it
    const events = first.trace.events;
    const cut = events.findIndex((e) => e.type === 'step.start' && e.step === 1);
    const truncated = Trace.parse(
      events
        .slice(0, cut)
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    // the loop wraps every Policy failure in PolicyError: the specific cause stays
    // reachable, and it is the one that says what really happened
    const error = await replay(truncated, { tools: new ToolRegistry([searchFlights]) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).cause).toBeInstanceOf(ReplayMismatchError);
    expect(((error as PolicyError).cause as Error).message).toMatch(
      /the trace has \d+ responses but the replay asked for \d+/,
    );
  });

  it('a trace without run.start is not a run trace', async () => {
    const empty = new Trace({ clock: () => 0 });
    empty.append({ type: 'step.start', step: 0 });
    await expect(replay(empty)).rejects.toThrow(ReplayMismatchError);
  });

  it('compare: false gives up declaring equality', async () => {
    const first = await executeRun();
    const { equal } = await replay(first.trace, { tools: new ToolRegistry([searchFlights]), compare: false });
    expect(equal).toBe(false);
  });

  it('altering the trace changes the replay consistently, not inconsistently', async () => {
    // the trace is the input of the replay: altering it changes *both* sides, so the
    // replay stays faithful to itself. What `equal` reports is a change of code (loop
    // or tool), and `live-tools` covers that with a different tool.
    const first = await executeRun();
    const altered = Trace.parse(first.trace.toJSONL().replace('90 euros', '10 euros'));
    const { result, equal } = await replay(altered, { tools: new ToolRegistry([searchFlights]) });
    expect(JSON.stringify(result.messages)).toContain('10 euros');
    expect(equal).toBe(true);
  });
});

describe('replay: the spending cap is redone the same way', () => {
  it('a run interrupted by the budget is redone interrupted by the budget, at the same step', async () => {
    const first = await run({
      policy: {
        model: 'expensive',
        decide: async () => ({ decision: { type: 'tool', call: { id: 'c', name: 'search_flights', args: {} } }, usage, model: 'expensive' }),
      },
      tools: new ToolRegistry([searchFlights]),
      messages: start,
      budget: new Budget(micros(1)),
      stepAllowance: micros(10),
    });
    expect(first.stopReason).toBe('budget');

    const { result } = await replay(first.trace, { tools: new ToolRegistry([searchFlights]) });
    expect(result.stopReason).toBe('budget');
    expect(result.steps).toBe(first.steps);
  });
});
