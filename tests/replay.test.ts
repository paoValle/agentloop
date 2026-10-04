import { describe, expect, it } from 'vitest';

import { Budget, micros, usd } from '../src/budget.js';
import { PolicyError, ReplayMismatchError } from '../src/errors.js';
import { run } from '../src/loop.js';
import { replay } from '../src/replay.js';
import { Trace } from '../src/trace.js';
import { ToolRegistry, ToolError } from '../src/tool.js';
import type { Policy, PolicyOutcome, Tool } from '../src/types.js';

const inizio = [{ role: 'user', content: 'cerca il volo per Napoli' }] as const;

/** Policy deterministica: ogni volta che parte, prende le stesse decisioni. */
function script(skrizioni: PolicyOutcome[]): Policy {
  let i = 0;
  return {
    model: 'registrato',
    decide: async () => {
      const next = skrizioni[i++];
      if (next === undefined) throw new Error('script esaurito');
      return next;
    },
  };
}

const usage = { inputTokens: 120, outputTokens: 40 };
const msg = (content: string): PolicyOutcome => ({ decision: { type: 'message', content }, usage, model: 'registrato' });
const call = (id: string, name: string, args: unknown): PolicyOutcome => ({
  decision: { type: 'tool', call: { id, name, args } },
  usage,
  model: 'registrato',
});

let contatore = 0;
const orologioLocale = (): Policy => {
  const ordine = [
    call('c1', 'cerca_voli', { da: 'NAP', a: 'FCO' }),
    msg('Il volo costa 90 euro.'),
  ];
  return script(ordine);
};

const cercaVoli: Tool = {
  name: 'cerca_voli',
  description: 'Cerca voli.',
  schema: {
    type: 'object',
    properties: { da: { type: 'string' }, a: { type: 'string' } },
    required: ['da', 'a'],
  },
  execute: () => [{ compagnia: 'ITA', prezzo: 90 }],
};

const eseguiRun = async (tools: ToolRegistry = new ToolRegistry([cercaVoli])) => {
  contatore += 1;
  return run({
    policy: orologioLocale(),
    tools,
    messages: inizio,
    budget: new Budget(usd(1)),
    runId: `r${contatore}`,
  });
};

describe('replay: rifare la stessa run', () => {
  it('una run con tool si rifà identica, senza rete e senza eseguire il tool', async () => {
    let esecuzioni = 0;
    const contatoreTool: Tool = {
      ...cercaVoli,
      execute: () => {
        esecuzioni += 1;
        return [{ compagnia: 'ITA', prezzo: 90 }];
      },
    };
    const primo = await eseguiRun(new ToolRegistry([contatoreTool]));
    expect(esecuzioni).toBe(1);

    const { result, equal, warnings } = await replay(primo.trace, {
      tools: new ToolRegistry([contatoreTool]),
    });

    expect(equal).toBe(true);
    expect(warnings).toEqual([]);
    expect(esecuzioni).toBe(1); // il replay non ha toccato il tool
    expect(result.messages).toEqual(primo.messages);
    expect(result.stopReason).toBe('end_turn');
  });

  it('accetta anche il JSONL: la traccia basta, non serve l’oggetto', async () => {
    const primo = await eseguiRun();
    const { equal } = await replay(primo.trace.toJSONL(), { tools: new ToolRegistry([cercaVoli]) });
    expect(equal).toBe(true);
  });

  it('la spesa del replay è identica a quella della run originale', async () => {
    const primo = await eseguiRun();
    const { result } = await replay(primo.trace, { tools: new ToolRegistry([cercaVoli]) });
    expect(result.spent).toBe(primo.spent);
    expect(result.steps).toBe(primo.steps);
  });

  it('i messaggi finali sono identici, non soltanto "simili"', async () => {
    const primo = await eseguiRun();
    const { result } = await replay(primo.trace, { tools: new ToolRegistry([cercaVoli]) });
    expect(result.messages).toStrictEqual(primo.messages);
    expect(result.answer).toBe(primo.answer);
  });
});

describe('replay: il fallimento dei tool si riproduce', () => {
  const rotto: Tool = {
    name: 'cerca_voli',
    description: 'Cerca voli.',
    schema: { type: 'object' },
    execute: () => {
      throw new ToolError('compagnia non disponibile', false);
    },
  };

  it('un ciclo di autocorrezione del modello si rifà', async () => {
    const primo = await run({
      policy: script([
        call('c1', 'cerca_voli', {}),
        call('c2', 'cerca_voli', {}),
        msg('Non ho trovato voli.'),
      ]),
      tools: new ToolRegistry([rotto]),
      messages: inizio,
      budget: new Budget(usd(1)),
    });
    expect(primo.messages.filter((m) => m.role === 'tool')).toHaveLength(2);

    const { result, equal } = await replay(primo.trace, { tools: new ToolRegistry([rotto]) });
    expect(equal).toBe(true);
    expect(result.messages).toEqual(primo.messages);
    expect(result.messages.find((m) => m.role === 'tool')?.content).toContain('compagnia non disponibile');
  });

  it('un errore interno non previsto non riappare con il suo testo nella run originale', async () => {
    const esplosivo: Tool = {
      name: 'cerca_voli',
      description: 'Cerca voli.',
      schema: { type: 'object' },
      execute: () => {
        throw new Error('ECONNREFUSED su 10.1.2.3 con token sk-live-XYZ');
      },
    };
    const primo = await run({
      policy: script([call('c1', 'cerca_voli', {}), msg('Non posso')]),
      tools: new ToolRegistry([esplosivo]),
      messages: inizio,
      budget: new Budget(usd(1)),
    });

    const { result } = await replay(primo.trace, { tools: new ToolRegistry([esplosivo]) });
    // il replay non deve ricostruire il testo dell'errore vero
    expect(JSON.stringify(result.messages)).not.toContain('sk-live-XYZ');
    expect(result.messages).toEqual(primo.messages);
  });
});

describe('replay: quando il tool è cambiato, si dice', () => {
  it('un tool modificato produce un avviso invece di una riproduzione falsa', async () => {
    const primo = await eseguiRun();

    const modificato: Tool = {
      ...cercaVoli,
      execute: () => [{ compagnia: 'easyJet', prezzo: 42 }],
    };
    const { warnings } = await replay(primo.trace, { tools: new ToolRegistry([modificato]) });

    const avviso = warnings.find((w) => w.kind === 'tool_changed');
    expect(avviso).toBeDefined();
    expect(avviso?.message).toContain('cerca_voli');
    expect(avviso?.message).toContain('impronta');
  });

  it('in live-tools il tool modificato viene davvero rieseguito, e la differenza si vede', async () => {
    const primo = await eseguiRun();

    let eseguito = false;
    const modificato: Tool = {
      ...cercaVoli,
      execute: () => {
        eseguito = true;
        return [{ compagnia: 'easyJet', prezzo: 42 }];
      },
    };
    const { result } = await replay(primo.trace, {
      mode: 'live-tools',
      tools: new ToolRegistry([modificato]),
    });

    expect(eseguito).toBe(true);
    expect(result.messages).not.toEqual(primo.messages);
    expect(JSON.stringify(result.messages)).toContain('easyJet');
  });

  it('un tool che manca viene segnalato', async () => {
    const primo = await eseguiRun();
    const { warnings } = await replay(primo.trace, { tools: new ToolRegistry() });
    expect(warnings.map((w) => w.kind)).toContain('tool_missing');
  });

  it('un tool nuovo che non ha servito viene segnalato come extra', async () => {
    const primo = await eseguiRun();
    const { warnings } = await replay(primo.trace, {
      tools: new ToolRegistry([cercaVoli, { name: 'nuovo', description: 'Mai usato.', schema: { type: 'object' }, execute: () => 1 }]),
    });
    expect(warnings.map((w) => w.kind)).toContain('extra_tool');
  });

  it('live-tools senza i tool veri è un errore di programmazione, non un replay silenzioso', async () => {
    const primo = await eseguiRun();
    await expect(replay(primo.trace, { mode: 'live-tools' })).rejects.toThrow(TypeError);
  });
});

describe('replay: quando non è più la stessa run', () => {
  it('un replay che chiede più decisioni di quante la traccia ne contenga si ferma', async () => {
    const primo = await eseguiRun();
    // si tiene solo il primo scambio e si lascia maxSteps com'era: il loop chiederà
    // una seconda decisione che in traccia non c'è, e deve dirlo invece di inventarla
    const eventi = primo.trace.events;
    const taglio = eventi.findIndex((e) => e.type === 'step.start' && e.step === 1);
    const troncata = Trace.parse(
      eventi
        .slice(0, taglio)
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );

    // il loop avvolge ogni fallimento della Policy in PolicyError: la causa specifica
    // resta raggiungibile, ed è quella che dice cosa è successo davvero
    const errore = await replay(troncata, { tools: new ToolRegistry([cercaVoli]) }).catch((e: unknown) => e);
    expect(errore).toBeInstanceOf(PolicyError);
    expect((errore as PolicyError).cause).toBeInstanceOf(ReplayMismatchError);
    expect(((errore as PolicyError).cause as Error).message).toMatch(
      /la traccia ha \d+ risposte ma il replay ne ha chiesto \d+/,
    );
  });

  it('una traccia senza run.start non è una traccia di run', async () => {
    const vuota = new Trace({ clock: () => 0 });
    vuota.append({ type: 'step.start', step: 0 });
    await expect(replay(vuota)).rejects.toThrow(ReplayMismatchError);
  });

  it('compare: false rinuncia a dichiarare l’uguaglianza', async () => {
    const primo = await eseguiRun();
    const { equal } = await replay(primo.trace, { tools: new ToolRegistry([cercaVoli]), compare: false });
    expect(equal).toBe(false);
  });

  it('alterare la traccia cambia il replay in modo coerente, non incoerente', async () => {
    // la traccia è l'ingresso del replay: alterarla cambia *entrambi* i lati, quindi
    // il replay resta fedele a sé stesso. Ciò che `equal` segnala è un cambiamento
    // del codice (loop o tool), e lo copre `live-tools` con un tool diverso.
    const primo = await eseguiRun();
    const alterata = Trace.parse(primo.trace.toJSONL().replace('90 euro', '10 euro'));
    const { result, equal } = await replay(alterata, { tools: new ToolRegistry([cercaVoli]) });
    expect(JSON.stringify(result.messages)).toContain('10 euro');
    expect(equal).toBe(true);
  });
});

describe('replay: il tetto di spesa viene rifatto uguale', () => {
  it('una run interrotta dal budget si rifà interrotta dal budget, allo stesso passo', async () => {
    const primo = await run({
      policy: {
        model: 'costoso',
        decide: async () => ({ decision: { type: 'tool', call: { id: 'c', name: 'cerca_voli', args: {} } }, usage, model: 'costoso' }),
      },
      tools: new ToolRegistry([cercaVoli]),
      messages: inizio,
      budget: new Budget(micros(1)),
      stepAllowance: micros(10),
    });
    expect(primo.stopReason).toBe('budget');

    const { result } = await replay(primo.trace, { tools: new ToolRegistry([cercaVoli]) });
    expect(result.stopReason).toBe('budget');
    expect(result.steps).toBe(primo.steps);
  });
});