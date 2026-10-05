import { describe, expect, it } from 'vitest';

import { PolicyError } from '../src/errors.js';
import { interpret, openAICompatible } from '../src/policy-openai.js';
import type { ToolSpec } from '../src/types.js';

const spec: ToolSpec[] = [
  {
    name: 'search_flights',
    description: 'Searches flights.',
    schema: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'] },
  },
];

const response = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('interpret', () => {
  it('a text response becomes a message decision', () => {
    const outcome = interpret({ model: 'gpt-4o-mini', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    expect(outcome).toEqual({
      decision: { type: 'message', content: 'hello' },
      usage: { inputTokens: 10, outputTokens: 3 },
      model: 'gpt-4o-mini',
    });
  });

  it('a tool call becomes a tool decision, with the arguments already parsed', () => {
    const outcome = interpret({
      model: 'gpt-4o-mini',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { tool_calls: [{ id: 'call_1', function: { name: 'search_flights', arguments: '{"from":"NAP"}' } }] },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });

    expect(outcome.decision).toEqual({
      type: 'tool',
      call: { id: 'call_1', name: 'search_flights', args: { from: 'NAP' } },
    });
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it('an empty response is an error, not an empty answer', () => {
    // closing the run with an empty answer would look like an answer: worse than failing
    expect(() => interpret({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })).toThrow(PolicyError);
    expect(() => interpret({ choices: [{ message: { content: '   ' } }] })).toThrow(/empty/);
  });

  it('a response with no choices is an error', () => {
    expect(() => interpret({ choices: [] })).toThrow(/no choices/);
    expect(() => interpret({})).toThrow(/no choices/);
  });

  it('non-JSON arguments are a provider error, not a silent fallback', () => {
    // a fallback here would pass {} to the tool, which would do something different
    // from what the model wanted
    expect(() =>
      interpret({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{from:' } }] } }] }),
    ).toThrow(/not valid JSON/);
  });

  it('a tool call with no name is not invented', () => {
    expect(() =>
      interpret({ choices: [{ message: { tool_calls: [{ id: 'c', function: {} }] } }] }),
    ).toThrow(/no name/);
  });

  it('a missing usage is worth zero, not undefined', () => {
    const outcome = interpret({ choices: [{ message: { content: 'x' } }] });
    expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('openAICompatible', () => {
  const base = { model: 'gpt-4o-mini', apiKey: 'k' };

  it('declares the model: that is what makes the budget possible', () => {
    expect(openAICompatible(base).model).toBe('gpt-4o-mini');
  });

  it('translates messages and tools into the provider format', async () => {
    let body: Record<string, unknown> = {};
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        body = JSON.parse((init?.body ?? '') as string) as Record<string, unknown>;
        return response({ model: 'gpt-4o-mini', choices: [{ message: { content: 'ok' } }] });
      },
    });

    await policy.decide({ messages: [{ role: 'user', content: 'hello' }], tools: spec });
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'search_flights', description: 'Searches flights.', parameters: spec[0]?.schema } },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('with no tools it does not ask for tool_choice', async () => {
    let body: Record<string, unknown> = {};
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        body = JSON.parse((init?.body ?? '') as string) as Record<string, unknown>;
        return response({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await policy.decide({ messages: [{ role: 'user', content: 'hello' }], tools: [] });
    expect(body.tool_choice).toBeUndefined();
  });

  it('a tool message travels with its tool_call_id', async () => {
    let body: { messages: Record<string, unknown>[] } = { messages: [] };
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        body = JSON.parse((init?.body ?? '') as string) as { messages: Record<string, unknown>[] };
        return response({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await policy.decide({
      messages: [{ role: 'tool', tool_call_id: 'call_1', name: 'search_flights', content: '90 euros' }],
      tools: [],
    });
    expect(body.messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', name: 'search_flights', content: '90 euros' });
  });

  it('an HTTP error carries the provider body, truncated', async () => {
    const policy = openAICompatible({
      ...base,
      fetch: async () =>
        new Response('rate limit reached', { status: 429, statusText: 'Too Many Requests' }),
    });
    await expect(policy.decide({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(
      /429 Too Many Requests: rate limit reached/,
    );
  });

  it('a network error is a PolicyError, not a raw exception', async () => {
    const policy = openAICompatible({
      ...base,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(policy.decide({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(PolicyError);
  });

  it('caller cancellation really closes the in-flight request', async () => {
    const controller = new AbortController();
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          // a real fetch that waits: it detaches only when the signal fires
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    const inFlight = policy.decide({
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      signal: controller.signal,
    });
    controller.abort();
    await expect(inFlight).rejects.toThrow(/cancelled by the caller/);
  });

  it('the timeout closes the request within the given time', async () => {
    const policy = openAICompatible({
      ...base,
      timeoutMs: 10,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(policy.decide({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(PolicyError);
  });
});
