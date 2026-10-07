import { describe, expect, it } from 'vitest';

import { Budget, micros, usd } from '../src/budget.js';
import { PolicyError } from '../src/errors.js';
import { run, resolvePrice, type RunResult } from '../src/loop.js';
import { Trace } from '../src/trace.js';
import { ToolRegistry, ToolError } from '../src/tool.js';
import type { DecideRequest, Policy, PolicyOutcome, Tool, ToolCall } from '../src/types.js';

const PRICES = {
  cheap: { input: micros(1_000), output: micros(4_000) },
  expensive: { input: micros(60_000), output: micros(120_000) },
};

const start = [{ role: 'user', content: 'hello' }] as const;

/** A Policy that returns preset decisions: no network, no waiting. */
function script(entries: PolicyOutcome[], model = 'cheap'): Policy {
  let i = 0;
  return {
    model,
    decide: async (_req: DecideRequest): Promise<PolicyOutcome> => {
      const next = entries[i++];
      if (next === undefined) throw new Error('script exhausted');
      return next;
    },
  };
}

const usage = (inputTokens = 100, outputTokens = 50) => ({ inputTokens, outputTokens });

const message = (content: string): PolicyOutcome => ({
  decision: { type: 'message', content },
  usage: usage(),
  model: 'cheap',
});

const callTool = (call: ToolCall): PolicyOutcome => ({
  decision: { type: 'tool', call },
  usage: usage(),
  model: 'cheap',
});

const runs = (name: string, output: unknown = 'ok'): Tool => ({
  name,
  description: `Runs ${name}.`,
  schema: { type: 'object' },
  execute: () => output,
});

const registry = (...tools: Tool[]): ToolRegistry => new ToolRegistry(tools);

describe('run: the happy path', () => {
  it('a model that answers immediately closes on the first step', async () => {
    const result = await run({ policy: script([message('good morning')]), budget: new Budget(usd(1)), messages: start });

    expect(result.stopReason).toBe('end_turn');
    expect(result.answer).toBe('good morning');
    expect(result.steps).toBe(1);
    expect(result.messages).toHaveLength(2);
  });

  it('a tool is executed and its result comes back into the context', async () => {
    const result = await run({
      policy: script([callTool({ id: 'c1', name: 'greet', args: {} }), message('done')]),
      tools: registry(runs('greet', 'hello from inside')),
      budget: new Budget(usd(1)),
      messages: start,
    });

    expect(result.stopReason).toBe('end_turn');
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ role: 'tool', name: 'greet', tool_call_id: 'c1', content: 'hello from inside' });
  });

  it('a non-string output is rendered as JSON in the context', async () => {
    const result = await run({
      policy: script([callTool({ id: 'c1', name: 'count', args: {} }), message('ok')]),
      tools: registry(runs('count', { n: 42 })),
      budget: new Budget(usd(1)),
      messages: start,
    });
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe('{"n":42}');
  });

  it('the Policy sees the registered tools and the accumulated messages', async () => {
    const seen: DecideRequest[] = [];
    const policy: Policy = {
      model: 'cheap',
      decide: async (req) => {
        seen.push(req);
        return req.messages.length > 2 ? message('ok') : callTool({ id: 'c1', name: 'greet', args: {} });
      },
    };
    await run({ policy, tools: registry(runs('greet')), budget: new Budget(usd(1)), messages: start });

    expect(seen[0]?.messages).toHaveLength(1);
    expect(seen[0]?.tools.map((t) => t.name)).toEqual(['greet']);
    expect(seen[1]?.messages).toHaveLength(3); // user, assistant[tool], tool
  });

  it('system messages pass through untouched', async () => {
    const result = await run({
      policy: script([message('ok')]),
      budget: new Budget(usd(1)),
      messages: [{ role: 'system', content: 'you are useful' }, ...start],
    });
    expect(result.messages[0]).toEqual({ role: 'system', content: 'you are useful' });
  });
});

describe('run: tool errors are events, not incidents', () => {
  it('a failing tool puts the message back to the model and the run continues', async () => {
    const broken: Tool = {
      name: 'load',
      description: 'Loads data.',
      schema: { type: 'object' },
      execute: () => {
        throw new ToolError('service unavailable', true);
      },
    };
    const result = await run({
      policy: script([callTool({ id: 'c1', name: 'load', args: {} }), message('I could not do it')]),
      tools: registry(broken),
      budget: new Budget(usd(1)),
      messages: start,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('service unavailable');
  });

  it('an unexpected error reaches the model without the content', async () => {
    const broken: Tool = {
      name: 'load',
      description: 'Loads data.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      },
    };
    const result = await run({
      policy: script([callTool({ id: 'c1', name: 'load', args: {} }), message('ok')]),
      tools: registry(broken),
      budget: new Budget(usd(1)),
      messages: start,
    });

    const content = result.messages.find((m) => m.role === 'tool')?.content ?? '';
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('10.0.0.5');
  });

  it('wrong arguments never reach the tool', async () => {
    let executed = false;
    const guarded: Tool = {
      name: 'order',
      description: 'Orders.',
      schema: {
        type: 'object',
        properties: { sku: { type: 'string' } },
        required: ['sku'],
      },
      execute: () => {
        executed = true;
        return 'order created';
      },
    };
    const result = await run({
      policy: script([callTool({ id: 'c1', name: 'order', args: { sku: 42 } }), message('ok')]),
      tools: registry(guarded),
      budget: new Budget(usd(1)),
      messages: start,
    });

    expect(executed).toBe(false);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('/sku');
  });
});

describe('run: the spending cap is not negotiable', () => {
  it('a run that is too expensive stops with "budget" and does not overrun it', async () => {
    const budget = new Budget(usd(0.001));
    const result = await run({
      // 60,000 µUSD/M input: 100 tokens cost 6 µUSD, but the default allowance is 50,000
      policy: script(
        [
          callTool({ id: 'c1', name: 'greet', args: {} }),
          callTool({ id: 'c2', name: 'greet', args: {} }),
          message('never arrived'),
        ],
        'expensive',
      ),
      tools: registry(runs('greet')),
      prices: PRICES,
      budget,
      stepAllowance: micros(10_000),
      messages: start,
    });

    expect(result.stopReason).toBe('budget');
    expect(result.answer).toBeUndefined();
    expect(result.spent).toBeLessThanOrEqual(budget.limit);
  });

  it('the real spend never exceeds the cap, not even by one micro-dollar', async () => {
    const budget = new Budget(micros(100));
    await run({
      policy: script(
        Array.from({ length: 50 }, (_v, i) => callTool({ id: `c${i}`, name: 'greet', args: {} })),
        'expensive',
      ),
      tools: registry(runs('greet')),
      prices: PRICES,
      budget,
      stepAllowance: micros(60),
      messages: start,
    });
    expect(budget.spent).toBeLessThanOrEqual(micros(100));
  });

  it('the cap is consumed by the real steps, not by the estimates', async () => {
    const budget = new Budget(usd(10));
    const result = await run({
      policy: script([message('a'), message('b'), message('c')], 'expensive'),
      prices: PRICES,
      budget,
      messages: start,
    });
    expect(result.steps).toBe(1); // closes on the first message
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.held).toBe(0);
  });

  it('no reservation is left open at the end', async () => {
    const budget = new Budget(usd(1));
    await run({ policy: script([message('ok')]), budget, prices: PRICES, messages: start });
    expect(budget.openReservations).toEqual([]);
  });
});

describe('run: the explicit stops', () => {
  it('maxSteps: an agent going in circles stops', async () => {
    let n = 0;
    const policy: Policy = {
      model: 'cheap',
      decide: async () => callTool({ id: `c${n++}`, name: 'greet', args: {} }),
    };
    const result = await run({
      policy,
      tools: registry(runs('greet')),
      budget: new Budget(usd(1)),
      maxSteps: 3,
      messages: start,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(3);
  });

  it('the default of 12 steps exists for a reason: an agent in circles costs money', async () => {
    const policy: Policy = {
      model: 'cheap',
      decide: async () => callTool({ id: 'c', name: 'greet', args: {} }),
    };
    const result = await run({ policy, tools: registry(runs('greet')), budget: new Budget(usd(1)), messages: start });
    expect(result.steps).toBe(12);
  });

  it('abort: cancellation interrupts and declares itself', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run({
      policy: script([message('never used')]),
      budget: new Budget(usd(1)),
      signal: controller.signal,
      messages: start,
    });
    expect(result.stopReason).toBe('aborted');
    expect(result.steps).toBe(0);
  });

  it('the model\'s "stop" decision is honored', async () => {
    const result = await run({
      policy: script([{ decision: { type: 'stop', reason: 'max_steps' }, usage: usage(), model: 'cheap' }]),
      budget: new Budget(usd(1)),
      messages: start,
    });
    expect(result.stopReason).toBe('max_steps');
  });
});

describe('run: failures are failures', () => {
  it('a Policy that does not answer raises PolicyError, not an outcome', async () => {
    const policy: Policy = {
      model: 'cheap',
      decide: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(run({ policy, budget: new Budget(usd(1)), messages: start })).rejects.toThrow(PolicyError);
  });

  it('if the Policy fails, the reservation is released', async () => {
    const budget = new Budget(usd(1));
    const policy: Policy = {
      model: 'cheap',
      decide: async () => {
        throw new Error('boom');
      },
    };
    await expect(run({ policy, budget, messages: start })).rejects.toThrow(PolicyError);
    expect(budget.spent).toBe(0);
    expect(budget.openReservations).toEqual([]);
  });

  it('a Policy that does not declare its model is a programming error', async () => {
    const policy = { decide: async () => message('x') } as unknown as Policy;
    await expect(run({ policy, budget: new Budget(usd(1)), messages: start })).rejects.toThrow(/does not declare its model/);
  });

  it('a run without initial messages is a programming error', async () => {
    await expect(run({ policy: script([message('x')]), budget: new Budget(usd(1)), messages: [] })).rejects.toThrow(TypeError);
  });
});

describe('resolvePrice', () => {
  it('uses the declared price when it exists', () => {
    expect(resolvePrice(PRICES, 'expensive').input).toBe(micros(60_000));
  });

  it('an unknown model is worth the highest known price, not zero', () => {
    // zero price = the budget looks like it protects something while it protects nothing
    const price = resolvePrice(PRICES, 'model-of-the-future');
    expect(price.input).toBe(micros(60_000));
    expect(price.output).toBe(micros(120_000));
  });

  it('with no table at all, everything costs zero: and that must be said', () => {
    expect(resolvePrice({}, 'x')).toEqual({ input: 0, output: 0 });
  });
});

describe('run: the trace tells the run', () => {
  it('emits the events in the order the loop produces them', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({
      policy: script([callTool({ id: 'c1', name: 'greet', args: {} }), message('finished')]),
      tools: registry(runs('greet', 'hello')),
      budget: new Budget(usd(1)),
      trace,
      messages: start,
    });

    expect(trace.events.map((e) => e.type)).toEqual([
      'run.start',
      'step.start',
      'policy.request',
      'policy.response',
      'budget.settle',
      'tool.call',
      'tool.result',
      'step.start',
      'policy.request',
      'policy.response',
      'budget.settle',
      'run.end',
    ]);
  });

  it('tool.call carries the tool fingerprint', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({
      policy: script([callTool({ id: 'c1', name: 'greet', args: {} }), message('finished')]),
      tools: registry(runs('greet')),
      budget: new Budget(usd(1)),
      trace,
      messages: start,
    });
    const call = trace.of('tool.call')[0];
    expect(call?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a sensitive tool does not write its data into the trace', async () => {
    const trace = new Trace({ clock: () => 0 });
    const sensitive: Tool = {
      name: 'read',
      description: 'Reads a profile.',
      schema: { type: 'object' },
      sensitive: true,
      execute: () => ({ name: 'Mario Rossi', ssn: 'RSSMRA80A01H501U' }),
    };
    await run({
      policy: script([
        callTool({ id: 'c1', name: 'read', args: { patient: 'Mario Rossi' } }),
        message('ok'),
      ]),
      tools: registry(sensitive),
      budget: new Budget(usd(1)),
      trace,
      messages: start,
    });

    const text = trace.toJSONL();
    expect(text).not.toContain('RSSMRA80A01H501U');
    expect(text).not.toContain('Mario Rossi');
  });

  it('run.end reports the spend and the reason it ended', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({ policy: script([message('ok')]), budget: new Budget(usd(1)), prices: PRICES, trace, messages: start });
    const end = trace.of('run.end')[0];
    expect(end).toMatchObject({ steps: 1, stopReason: 'end_turn' });
    expect(end?.spentUsd).toMatch(/^\d+\.\d{6}$/);
  });

  it('two identical runs produce identical traces modulo time', async () => {
    const execute = async (): Promise<RunResult> =>
      run({
        policy: script([callTool({ id: 'c1', name: 'greet', args: {} }), message('ok')]),
        tools: registry(runs('greet', 'hello')),
        budget: new Budget(usd(1)),
        prices: PRICES,
        messages: start,
      });
    expect((await execute()).trace.normalized()).toEqual((await execute()).trace.normalized());
  });
});

describe('the trace carries what the policy chose to keep', () => {
  it('writes the provider response verbatim as a policy.raw event', async () => {
    const raw = { id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] };
    const result = await run({
      policy: script([{ ...message('hi'), raw }]),
      budget: new Budget(usd(1)),
      messages: start,
    });

    const written = result.trace.events.filter((event) => event.type === 'policy.raw');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ step: 0, model: 'cheap', body: raw });
  });

  it('writes no such event when the policy does not return one', async () => {
    const result = await run({ policy: script([message('hi')]), budget: new Budget(usd(1)), messages: start });
    expect(result.trace.events.some((event) => event.type === 'policy.raw')).toBe(false);
  });
});
