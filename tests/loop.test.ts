import { describe, expect, it } from 'vitest';

import { Budget, micros, usd } from '../src/budget.js';
import { PolicyError } from '../src/errors.js';
import { run, resolvePrice, type RunResult } from '../src/loop.js';
import { Trace } from '../src/trace.js';
import { ToolRegistry, ToolError } from '../src/tool.js';
import type { DecideRequest, Policy, PolicyOutcome, Tool, ToolCall } from '../src/types.js';

const PREZZI = {
  economico: { input: micros(1_000), output: micros(4_000) },
  costoso: { input: micros(60_000), output: micros(120_000) },
};

const inizio = [{ role: 'user', content: 'ciao' }] as const;

/** Una Policy che restituisce decisioni prefissate: nessuna rete, nessuna attesa. */
function script(skrizioni: PolicyOutcome[], modello = 'economico'): Policy {
  let i = 0;
  return {
    model: modello,
    decide: async (_req: DecideRequest): Promise<PolicyOutcome> => {
      const next = skrizioni[i++];
      if (next === undefined) throw new Error('script esaurito');
      return next;
    },
  };
}

const usage = (inputTokens = 100, outputTokens = 50) => ({ inputTokens, outputTokens });

const messaggio = (content: string): PolicyOutcome => ({
  decision: { type: 'message', content },
  usage: usage(),
  model: 'economico',
});

const chiamaTool = (call: ToolCall): PolicyOutcome => ({
  decision: { type: 'tool', call },
  usage: usage(),
  model: 'economico',
});

const esegue = (name: string, output: unknown = 'ok'): Tool => ({
  name,
  description: `Esegue ${name}.`,
  schema: { type: 'object' },
  execute: () => output,
});

const registro = (...tools: Tool[]): ToolRegistry => new ToolRegistry(tools);

describe('run: il percorso normale', () => {
  it('un modello che risponde subito chiude al primo passo', async () => {
    const result = await run({ policy: script([messaggio('buongiorno')]), budget: new Budget(usd(1)), messages: inizio });

    expect(result.stopReason).toBe('end_turn');
    expect(result.answer).toBe('buongiorno');
    expect(result.steps).toBe(1);
    expect(result.messages).toHaveLength(2);
  });

  it('un tool viene eseguito e il suo risultato torna nel contesto', async () => {
    const result = await run({
      policy: script([chiamaTool({ id: 'c1', name: 'saluta', args: {} }), messaggio('fatto')]),
      tools: registro(esegue('saluta', 'ciao da dentro')),
      budget: new Budget(usd(1)),
      messages: inizio,
    });

    expect(result.stopReason).toBe('end_turn');
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toMatchObject({ role: 'tool', name: 'saluta', tool_call_id: 'c1', content: 'ciao da dentro' });
  });

  it('un output non stringa viene reso JSON nel contesto', async () => {
    const result = await run({
      policy: script([chiamaTool({ id: 'c1', name: 'conta', args: {} }), messaggio('ok')]),
      tools: registro(esegue('conta', { n: 42 })),
      budget: new Budget(usd(1)),
      messages: inizio,
    });
    expect(result.messages.find((m) => m.role === 'tool')?.content).toBe('{"n":42}');
  });

  it('la Policy vede i tool registrati e i messaggi accumulati', async () => {
    const visti: DecideRequest[] = [];
    const policy: Policy = {
      model: 'economico',
      decide: async (req) => {
        visti.push(req);
        return req.messages.length > 2 ? messaggio('ok') : chiamaTool({ id: 'c1', name: 'saluta', args: {} });
      },
    };
    await run({ policy, tools: registro(esegue('saluta')), budget: new Budget(usd(1)), messages: inizio });

    expect(visti[0]?.messages).toHaveLength(1);
    expect(visti[0]?.tools.map((t) => t.name)).toEqual(['saluta']);
    expect(visti[1]?.messages).toHaveLength(3); // utente, assistant[tool], tool
  });

  it('i message di sistema passano intatti', async () => {
    const result = await run({
      policy: script([messaggio('ok')]),
      budget: new Budget(usd(1)),
      messages: [{ role: 'system', content: 'sei utile' }, ...inizio],
    });
    expect(result.messages[0]).toEqual({ role: 'system', content: 'sei utile' });
  });
});

describe('run: gli errori dei tool sono eventi, non incidenti', () => {
  it('un tool che fallisce rimette il messaggio al modello e il run prosegue', async () => {
    const rotto: Tool = {
      name: 'carica',
      description: 'Carica dati.',
      schema: { type: 'object' },
      execute: () => {
        throw new ToolError('servizio non disponibile', true);
      },
    };
    const result = await run({
      policy: script([chiamaTool({ id: 'c1', name: 'carica', args: {} }), messaggio('non sono riuscito')]),
      tools: registro(rotto),
      budget: new Budget(usd(1)),
      messages: inizio,
    });

    expect(result.stopReason).toBe('end_turn');
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('servizio non disponibile');
  });

  it('un errore non previsto arriva al modello senza il contenuto', async () => {
    const rotto: Tool = {
      name: 'carica',
      description: 'Carica dati.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      },
    };
    const result = await run({
      policy: script([chiamaTool({ id: 'c1', name: 'carica', args: {} }), messaggio('ok')]),
      tools: registro(rotto),
      budget: new Budget(usd(1)),
      messages: inizio,
    });

    const content = result.messages.find((m) => m.role === 'tool')?.content ?? '';
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('10.0.0.5');
  });

  it('gli argomenti sbagliati non raggiungono il tool', async () => {
    let eseguito = false;
    const sorvegliato: Tool = {
      name: 'ordina',
      description: 'Ordina.',
      schema: {
        type: 'object',
        properties: { sku: { type: 'string' } },
        required: ['sku'],
      },
      execute: () => {
        eseguito = true;
        return 'ordine creato';
      },
    };
    const result = await run({
      policy: script([chiamaTool({ id: 'c1', name: 'ordina', args: { sku: 42 } }), messaggio('ok')]),
      tools: registro(sorvegliato),
      budget: new Budget(usd(1)),
      messages: inizio,
    });

    expect(eseguito).toBe(false);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('/sku');
  });
});

describe('run: il tetto di spesa non è negoziabile', () => {
  it('un run troppo costoso si ferma con "budget" e non lo oltrepassa', async () => {
    const budget = new Budget(usd(0.001));
    const result = await run({
      // 60.000 µUSD/M input: 100 token costano 6 µUSD, ma l'allowance di default è 50.000
      policy: script(
        [
          chiamaTool({ id: 'c1', name: 'saluta', args: {} }),
          chiamaTool({ id: 'c2', name: 'saluta', args: {} }),
          messaggio('mai arrivata'),
        ],
        'costoso',
      ),
      tools: registro(esegue('saluta')),
      prices: PREZZI,
      budget,
      stepAllowance: micros(10_000),
      messages: inizio,
    });

    expect(result.stopReason).toBe('budget');
    expect(result.answer).toBeUndefined();
    expect(result.spent).toBeLessThanOrEqual(budget.limit);
  });

  it('la spesa reale non supera mai il tetto, nemmeno di un micro-dollaro', async () => {
    const budget = new Budget(micros(100));
    await run({
      policy: script(
        Array.from({ length: 50 }, (_v, i) => chiamaTool({ id: `c${i}`, name: 'saluta', args: {} })),
        'costoso',
      ),
      tools: registro(esegue('saluta')),
      prices: PREZZI,
      budget,
      stepAllowance: micros(60),
      messages: inizio,
    });
    expect(budget.spent).toBeLessThanOrEqual(micros(100));
  });

  it('il tetto si consuma sui passi reali, non sulle stime', async () => {
    const budget = new Budget(usd(10));
    const result = await run({
      policy: script([messaggio('a'), messaggio('b'), messaggio('c')], 'costoso'),
      prices: PREZZI,
      budget,
      messages: inizio,
    });
    expect(result.steps).toBe(1); // chiude al primo messaggio
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.held).toBe(0);
  });

  it('nessuna prenotazione resta aperta alla fine', async () => {
    const budget = new Budget(usd(1));
    await run({ policy: script([messaggio('ok')]), budget, prices: PREZZI, messages: inizio });
    expect(budget.openReservations).toEqual([]);
  });
});

describe('run: gli arresti espliciti', () => {
  it('maxSteps: un agente che gira in tondo si ferma', async () => {
    let n = 0;
    const policy: Policy = {
      model: 'economico',
      decide: async () => chiamaTool({ id: `c${n++}`, name: 'saluta', args: {} }),
    };
    const result = await run({
      policy,
      tools: registro(esegue('saluta')),
      budget: new Budget(usd(1)),
      maxSteps: 3,
      messages: inizio,
    });
    expect(result.stopReason).toBe('max_steps');
    expect(result.steps).toBe(3);
  });

  it('il default di 12 passi esiste per un motivo: un agente in tondo costa', async () => {
    const policy: Policy = {
      model: 'economico',
      decide: async () => chiamaTool({ id: 'c', name: 'saluta', args: {} }),
    };
    const result = await run({ policy, tools: registro(esegue('saluta')), budget: new Budget(usd(1)), messages: inizio });
    expect(result.steps).toBe(12);
  });

  it('abort: la cancellazione interrompe e si dichiara', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run({
      policy: script([messaggio('mai usata')]),
      budget: new Budget(usd(1)),
      signal: controller.signal,
      messages: inizio,
    });
    expect(result.stopReason).toBe('aborted');
    expect(result.steps).toBe(0);
  });

  it('la decisione "stop" del modello viene rispettata', async () => {
    const result = await run({
      policy: script([{ decision: { type: 'stop', reason: 'max_steps' }, usage: usage(), model: 'economico' }]),
      budget: new Budget(usd(1)),
      messages: inizio,
    });
    expect(result.stopReason).toBe('max_steps');
  });
});

describe('run: i guasti sono guasti', () => {
  it('una Policy che non risponde solleva PolicyError, non un esito', async () => {
    const policy: Policy = {
      model: 'economico',
      decide: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(run({ policy, budget: new Budget(usd(1)), messages: inizio })).rejects.toThrow(PolicyError);
  });

  it('se la Policy fallisce, la prenotazione viene liberata', async () => {
    const budget = new Budget(usd(1));
    const policy: Policy = {
      model: 'economico',
      decide: async () => {
        throw new Error('boom');
      },
    };
    await expect(run({ policy, budget, messages: inizio })).rejects.toThrow(PolicyError);
    expect(budget.spent).toBe(0);
    expect(budget.openReservations).toEqual([]);
  });

  it('una Policy che non dichiara il modello è un errore di programmazione', async () => {
    const policy = { decide: async () => messaggio('x') } as unknown as Policy;
    await expect(run({ policy, budget: new Budget(usd(1)), messages: inizio })).rejects.toThrow(/non dichiara il suo modello/);
  });

  it('un run senza messaggi iniziali è un errore di programmazione', async () => {
    await expect(run({ policy: script([messaggio('x')]), budget: new Budget(usd(1)), messages: [] })).rejects.toThrow(TypeError);
  });
});

describe('resolvePrice', () => {
  it('usa il prezzo dichiarato quando esiste', () => {
    expect(resolvePrice(PREZZI, 'costoso').input).toBe(micros(60_000));
  });

  it('un modello sconosciuto vale il massimo noto, non zero', () => {
    // prezzo zero = il budget sembra proteggere mentre non protegge niente
    const price = resolvePrice(PREZZI, 'modello-del-futuro');
    expect(price.input).toBe(micros(60_000));
    expect(price.output).toBe(micros(120_000));
  });

  it('senza tabella alcuna, tutto costa zero: e va detto', () => {
    expect(resolvePrice({}, 'x')).toEqual({ input: 0, output: 0 });
  });
});

describe('run: la traccia racconta il run', () => {
  it('emette gli eventi nell’ordine in cui il loop li produce', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({
      policy: script([chiamaTool({ id: 'c1', name: 'saluta', args: {} }), messaggio('finito')]),
      tools: registro(esegue('saluta', 'ciao')),
      budget: new Budget(usd(1)),
      trace,
      messages: inizio,
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

  it('il tool.call porta l’impronta del tool', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({
      policy: script([chiamaTool({ id: 'c1', name: 'saluta', args: {} }), messaggio('finito')]),
      tools: registro(esegue('saluta')),
      budget: new Budget(usd(1)),
      trace,
      messages: inizio,
    });
    const call = trace.of('tool.call')[0];
    expect(call?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('un tool sensibile non scrive i suoi dati in traccia', async () => {
    const trace = new Trace({ clock: () => 0 });
    const sensibile: Tool = {
      name: 'leggi',
      description: 'Legge un profilo.',
      schema: { type: 'object' },
      sensitive: true,
      execute: () => ({ nome: 'Mario Rossi', cf: 'RSSMRA80A01H501U' }),
    };
    await run({
      policy: script([
        chiamaTool({ id: 'c1', name: 'leggi', args: { paziente: 'Mario Rossi' } }),
        messaggio('ok'),
      ]),
      tools: registro(sensibile),
      budget: new Budget(usd(1)),
      trace,
      messages: inizio,
    });

    const testo = trace.toJSONL();
    expect(testo).not.toContain('RSSMRA80A01H501U');
    expect(testo).not.toContain('Mario Rossi');
  });

  it('run.end riporta spesa e motivo della fine', async () => {
    const trace = new Trace({ clock: () => 0 });
    await run({ policy: script([messaggio('ok')]), budget: new Budget(usd(1)), prices: PREZZI, trace, messages: inizio });
    const fine = trace.of('run.end')[0];
    expect(fine).toMatchObject({ steps: 1, stopReason: 'end_turn' });
    expect(fine?.spentUsd).toMatch(/^\d+\.\d{6}$/);
  });

  it('due run identici producono tracce identiche modulo il tempo', async () => {
    const esegui = async (): Promise<RunResult> =>
      run({
        policy: script([chiamaTool({ id: 'c1', name: 'saluta', args: {} }), messaggio('ok')]),
        tools: registro(esegue('saluta', 'ciao')),
        budget: new Budget(usd(1)),
        prices: PREZZI,
        messages: inizio,
      });
    expect((await esegui()).trace.normalized()).toEqual((await esegui()).trace.normalized());
  });
});