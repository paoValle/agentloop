import { describe, expect, it } from 'vitest';

import { PolicyError } from '../src/errors.js';
import { interpret, openAICompatible } from '../src/policy-openai.js';
import type { ToolSpec } from '../src/types.js';

const spec: ToolSpec[] = [
  {
    name: 'cerca_voli',
    description: 'Cerca voli.',
    schema: { type: 'object', properties: { da: { type: 'string' } }, required: ['da'] },
  },
];

const risposta = (corpo: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('interpret', () => {
  it('una risposta testuale diventa una decisione di messaggio', () => {
    const esito = interpret({ model: 'gpt-4o-mini', choices: [{ message: { content: 'ciao' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    expect(esito).toEqual({
      decision: { type: 'message', content: 'ciao' },
      usage: { inputTokens: 10, outputTokens: 3 },
      model: 'gpt-4o-mini',
    });
  });

  it('una tool call diventa una decisione di tool, con gli argomenti già parsati', () => {
    const esito = interpret({
      model: 'gpt-4o-mini',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { tool_calls: [{ id: 'call_1', function: { name: 'cerca_voli', arguments: '{"da":"NAP"}' } }] },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });

    expect(esito.decision).toEqual({
      type: 'tool',
      call: { id: 'call_1', name: 'cerca_voli', args: { da: 'NAP' } },
    });
    expect(esito.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it('una risposta vuota è un errore, non una risposta vuota', () => {
    // chiudere il run con un answer vuoto sembrerebbe una risposta: peggio che fallire
    expect(() => interpret({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })).toThrow(PolicyError);
    expect(() => interpret({ choices: [{ message: { content: '   ' } }] })).toThrow(/vuota/);
  });

  it('una risposta senza scelte è un errore', () => {
    expect(() => interpret({ choices: [] })).toThrow(/senza scelte/);
    expect(() => interpret({})).toThrow(/senza scelte/);
  });

  it('argomenti non JSON sono un errore del provider, non un fallback silenzioso', () => {
    // un fallback qui passerebbe {} al tool, che farebbe qualcosa di diverso
    // da quello che il modello voleva
    expect(() =>
      interpret({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{da:' } }] } }] }),
    ).toThrow(/non sono JSON valido/);
  });

  it('una tool call senza nome non viene inventata', () => {
    expect(() =>
      interpret({ choices: [{ message: { tool_calls: [{ id: 'c', function: {} }] } }] }),
    ).toThrow(/senza nome/);
  });

  it('usage assente vale zero, non undefined', () => {
    const esito = interpret({ choices: [{ message: { content: 'x' } }] });
    expect(esito.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('openAICompatible', () => {
  const base = { model: 'gpt-4o-mini', apiKey: 'k' };

  it('dichiiara il modello: è ciò che rende possibile il budget', () => {
    expect(openAICompatible(base).model).toBe('gpt-4o-mini');
  });

  it('traduce messaggi e tool nel formato del provider', async () => {
    let corpo: Record<string, unknown> = {};
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        corpo = JSON.parse((init?.body ?? '') as string) as Record<string, unknown>;
        return risposta({ model: 'gpt-4o-mini', choices: [{ message: { content: 'ok' } }] });
      },
    });

    await policy.decide({ messages: [{ role: 'user', content: 'ciao' }], tools: spec });
    expect(corpo.model).toBe('gpt-4o-mini');
    expect(corpo.tools).toEqual([
      { type: 'function', function: { name: 'cerca_voli', description: 'Cerca voli.', parameters: spec[0]?.schema } },
    ]);
    expect(corpo.tool_choice).toBe('auto');
  });

  it('senza tool non chiede tool_choice', async () => {
    let corpo: Record<string, unknown> = {};
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        corpo = JSON.parse((init?.body ?? '') as string) as Record<string, unknown>;
        return risposta({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await policy.decide({ messages: [{ role: 'user', content: 'ciao' }], tools: [] });
    expect(corpo.tool_choice).toBeUndefined();
  });

  it('un messaggio di tool viaggia con il suo tool_call_id', async () => {
    let corpo: { messages: Record<string, unknown>[] } = { messages: [] };
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) => {
        corpo = JSON.parse((init?.body ?? '') as string) as { messages: Record<string, unknown>[] };
        return risposta({ choices: [{ message: { content: 'ok' } }] });
      },
    });
    await policy.decide({
      messages: [{ role: 'tool', tool_call_id: 'call_1', name: 'cerca_voli', content: '90 euro' }],
      tools: [],
    });
    expect(corpo.messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', name: 'cerca_voli', content: '90 euro' });
  });

  it('un errore HTTP porta il corpo del provider, troncato', async () => {
    const policy = openAICompatible({
      ...base,
      fetch: async () =>
        new Response('rate limit reached', { status: 429, statusText: 'Too Many Requests' }),
    });
    await expect(policy.decide({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(
      /429 Too Many Requests: rate limit reached/,
    );
  });

  it('un errore di rete è un PolicyError, non un’eccezione raw', async () => {
    const policy = openAICompatible({
      ...base,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(policy.decide({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(PolicyError);
  });

  it('l’annullamento del chiamante chiude davvero la richiesta in volo', async () => {
    const controller = new AbortController();
    const policy = openAICompatible({
      ...base,
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          // un fetch vero che aspetta: si stacca solo quando il segnale scatta
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });

    const inCorso = policy.decide({
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      signal: controller.signal,
    });
    controller.abort();
    await expect(inCorso).rejects.toThrow(/annullata dal chiamante/);
  });

  it('il timeout chiude la richiesta entro il tempo dato', async () => {
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