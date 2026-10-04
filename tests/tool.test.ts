import { describe, expect, it } from 'vitest';

import { UnsupportedSchemaKeywordError } from '../src/errors.js';
import type { JsonSchema } from '../src/schema.js';
import { ToolError, ToolRegistry, invalidArgumentsMessage, invokeTool } from '../src/tool.js';
import type { Tool, ToolCall, ToolContext } from '../src/types.js';

const ctx: ToolContext = { stepId: 'step-1' };

const somma = (): Tool<{ a: number; b: number }, number> => ({
  name: 'somma',
  description: 'Somma due numeri.',
  schema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  execute: (input: { a: number; b: number }) => input.a + input.b,
});

const call = (name: string, args: unknown): ToolCall => ({ id: 'call-1', name, args });

describe('ToolRegistry: controlli all’ingresso', () => {
  it('registra e rende visibili i tool al modello', () => {
    const registry = new ToolRegistry([somma()]);
    expect(registry.size).toBe(1);
    expect(registry.names()).toEqual(['somma']);
    expect(registry.specs()[0]).toMatchObject({ name: 'somma', description: 'Somma due numeri.' });
  });

  it('rifiuta un nome che non può diventare un identificatore', () => {
    for (const name of ['9lives', 'con spazio', 'con.punto', '', 'a'.repeat(65)]) {
      expect(() => new ToolRegistry([{ ...somma(), name }])).toThrow(TypeError);
    }
  });

  it('rifiuta una descrizione vuota: il modello non ha nulla su cui basarsi', () => {
    expect(() => new ToolRegistry([{ ...somma(), description: '   ' }])).toThrow(/descrizione vuota/);
  });

  it('rifiuta i duplicati invece di sostituirli in silenzio', () => {
    const registry = new ToolRegistry([somma()]);
    expect(() => registry.add(somma())).toThrow(/duplicato/);
    expect(registry.size).toBe(1);
  });

  it('rifiuta uno schema con parole chiave fuori sottoinsieme, all’ingresso', () => {
    const rotto = { ...somma(), schema: { type: 'string', pattern: '^x$' } as unknown as JsonSchema };
    expect(() => new ToolRegistry([rotto])).toThrow(UnsupportedSchemaKeywordError);
  });

  it('le specifiche non contengono codice eseguibile', () => {
    const registry = new ToolRegistry([somma()]);
    expect(Object.keys(registry.specs()[0] as object).sort()).toEqual(['description', 'name', 'schema']);
  });
});

describe('ToolRegistry: impronta', () => {
  it('cambia se il corpo del tool cambia', () => {
    const a = new ToolRegistry([somma()]);
    const b = new ToolRegistry([{ ...somma(), execute: (input: { a: number; b: number }) => input.a * input.b }]);
    expect(a.fingerprint('somma')).not.toBe(b.fingerprint('somma'));
  });

  it('cambia se lo schema cambia', () => {
    const a = new ToolRegistry([somma()]);
    const b = new ToolRegistry([{ ...somma(), schema: { type: 'object', properties: {} } }]);
    expect(a.fingerprint('somma')).not.toBe(b.fingerprint('somma'));
  });

  it('è stabile a parità di tool', () => {
    expect(new ToolRegistry([somma()]).fingerprint('somma')).toBe(new ToolRegistry([somma()]).fingerprint('somma'));
  });

  it('undefined per un tool che non esiste', () => {
    expect(new ToolRegistry().fingerprint('fantasma')).toBeUndefined();
  });
});

describe('invokeTool: il percorso felice', () => {
  it('esegue e restituisce l’output', async () => {
    const registry = new ToolRegistry([somma()]);
    const outcome = await invokeTool(registry, call('somma', { a: 2, b: 3 }), ctx);
    expect(outcome).toEqual({ ok: true, output: 5 });
  });

  it('passa il contesto al tool', async () => {
    let visto: string | undefined;
    const spy: Tool = {
      name: 'spy',
      description: 'Registra lo step.',
      schema: { type: 'object' },
      execute: (_input, c) => {
        visto = c.stepId;
      },
    };
    await invokeTool(new ToolRegistry([spy]), call('spy', {}), { stepId: 'step-7' });
    expect(visto).toBe('step-7');
  });
});

describe('invokeTool: gli argomenti del modello', () => {
  it('un tool inesistente diventa un messaggio che elenca quelli veri', async () => {
    const registry = new ToolRegistry([somma()]);
    const outcome = await invokeTool(registry, call('moltiplica', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('unknown_tool');
    expect(outcome.failure.message).toContain('moltiplica');
    expect(outcome.failure.message).toContain('somma');
  });

  it('gli argomenti invalidi non raggiungono mai il codice del tool', async () => {
    let eseguito = false;
    const sorvegliato: Tool<{ a: number; b: number }, number> = {
      ...somma(),
      execute: (input) => {
        eseguito = true;
        return input.a + input.b;
      },
    };
    const outcome = await invokeTool(new ToolRegistry([sorvegliato]), call('somma', { a: 1 }), ctx);
    expect(eseguito).toBe(false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('invalid_arguments');
    expect(outcome.failure.message).toContain('/b');
  });

  it('il messaggio di validazione cita il campo e cosa manca', () => {
    const message = invalidArgumentsMessage('somma', [
      { path: '/b', message: 'campo obbligatorio mancante' },
      { path: '/a', message: 'atteso number, ricevuto la stringa "x"' },
    ]);
    expect(message).toContain('- /b: campo obbligatorio mancante');
    expect(message).toContain('- /a: atteso number');
    expect(message).toContain('Correggi solo i campi indicati');
  });
});

describe('invokeTool: cosa si mostra al modello (ADR 0004)', () => {
  it('ToolError: il messaggio passa intero, il modello può correggere', async () => {
    const tool: Tool = {
      name: 'ordine',
      description: 'Crea un ordine.',
      schema: { type: 'object' },
      execute: () => {
        throw new ToolError('Giacenze insufficienti per sku-42: disponibili 1, richiesti 3.', true);
      },
    };
    const outcome = await invokeTool(new ToolRegistry([tool]), call('ordine', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.message).toContain('Giacenze insufficienti');
    expect(outcome.failure.message).toContain('Puoi riprovare');
  });

  it('un errore non previsto NON raggiunge il modello: niente segreti, niente path', async () => {
    const tool: Tool = {
      name: 'ordine',
      description: 'Crea un ordine.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('401 Unauthorized: token sk-live-ABCDEF su /var/secrets/prod.env');
      },
    };
    const outcome = await invokeTool(new ToolRegistry([tool]), call('ordine', {}), ctx);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // il messaggio non contiene nessun pezzo dell'errore vero
    expect(outcome.failure.message).not.toContain('sk-live-ABCDEF');
    expect(outcome.failure.message).not.toContain('/var/secrets');
    expect(outcome.failure.message).not.toContain('401');
    // e dice cosa fare
    expect(outcome.failure.message).toContain('Non riprovare più di una volta');
  });

  it('il testo non dipende in nessun modo dall’errore vero', async () => {
    // due tool con lo stesso nome ma cause diverse: messaggi identici bit per bit
    const boom = (segreto: string): Tool => ({
      name: 'pagamento',
      description: 'Esegue il pagamento.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error(segreto);
      },
    });
    const a = await invokeTool(new ToolRegistry([boom('segreto-1 sk-live-AAA')]), call('pagamento', {}), ctx);
    const b = await invokeTool(new ToolRegistry([boom('segreto-2 sk-live-BBB')]), call('pagamento', {}), ctx);
    expect(a.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.failure.message).toBe(b.failure.message);
  });
});

describe('invokeTool: cancellazione', () => {
  it('un AbortError attraversa: non è un errore del tool e non va autocorretti', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool: Tool = {
      name: 'lento',
      description: 'Tarda.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('il chiamante ha annullato');
      },
    };
    await expect(
      invokeTool(new ToolRegistry([tool]), call('lento', {}), { ...ctx, signal: controller.signal }),
    ).rejects.toThrow(/annullato/);
  });
});