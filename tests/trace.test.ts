import { describe, expect, it } from 'vitest';

import {
  MAX_TRACE_VALUE_BYTES,
  Trace,
  prepareForTrace,
  redact,
  toTraceable,
  traceableCall,
} from '../src/trace.js';

const fisso = (): Trace => new Trace({ clock: () => 1_700_000_000_000 });

describe('toTraceable: non deve mai fallire', () => {
  it('passa attraverso i valori semplici', () => {
    expect(toTraceable({ a: 1, b: 'x', c: [true, null] })).toEqual({ a: 1, b: 'x', c: [true, null] });
  });

  it('un Error diventa nome e messaggio, non stack con path assoluti', () => {
    expect(toTraceable(new TypeError('non è un numero'))).toEqual({
      name: 'TypeError',
      message: 'non è un numero',
    });
  });

  it('un ciclo non ricorre all’infinito', () => {
    const cyclic: Record<string, unknown> = { nome: 'x' };
    cyclic.seStesso = cyclic;
    expect(toTraceable(cyclic)).toMatchObject({ nome: 'x', seStesso: { degraded: 'ciclo' } });
  });

  it('degrada quello che non ha senso serializzare', () => {
    expect(toTraceable(Number.NaN)).toEqual({ degraded: 'number: NaN' });
    expect(toTraceable(10n)).toEqual({ degraded: 'bigint: 10' });
    expect(toTraceable(new Map([['a', 1]]))).toEqual({ degraded: 'Map(1)' });
    expect(toTraceable(new Set([1]))).toEqual({ degraded: 'Set(1)' });
    expect(toTraceable(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(toTraceable(() => undefined)).toEqual({ degraded: 'function: anonima' });
  });

  it('taglia la profondità invece di scendere all’inferno', () => {
    let deep: Record<string, unknown> = { fine: true };
    for (let i = 0; i < 30; i++) deep = { sotto: deep };
    expect(JSON.stringify(toTraceable(deep))).toContain('profondità massima');
  });

  it('lo stesso oggetto che compare due volte non diventa un falso ciclo', () => {
    const condiviso = { k: 1 };
    expect(toTraceable({ a: condiviso, b: condiviso })).toEqual({ a: { k: 1 }, b: { k: 1 } });
  });
});

describe('ridazione', () => {
  it('un tool sensibile non scrive il contenuto, ma dice quanto era grande', () => {
    const paziente = { nome: 'Mario Rossi', email: 'mario@example.com' };
    expect(redact(paziente)).toEqual({ redacted: true, bytes: JSON.stringify(paziente).length });
  });

  it('il contenuto redatto è davvero sparito', () => {
    const scritto = JSON.stringify(prepareForTrace({ email: 'mario@example.com' }, { sensitive: true }));
    expect(scritto).not.toContain('mario@example.com');
    expect(scritto).toContain('"redacted":true');
  });
});

describe('troncamento', () => {
  it('sotto la soglia non si tocca', () => {
    expect(prepareForTrace({ piccolo: 1 }, { sensitive: false })).toEqual({ piccolo: 1 });
  });

  it('sopra la soglia dichiara cosa è stato tagliato', () => {
    const enorme = { dati: 'x'.repeat(MAX_TRACE_VALUE_BYTES * 2) };
    const out = prepareForTrace(enorme, { sensitive: false }) as Record<string, unknown>;
    expect(out.__truncated).toMatchObject({ truncated: true });
    expect((out.__truncated as { bytes: number }).bytes).toBeGreaterThan(MAX_TRACE_VALUE_BYTES);
  });

  it('il ridatto non viene troncato: la sua dimensione è già un fatto utile', () => {
    const enorme = 'x'.repeat(MAX_TRACE_VALUE_BYTES * 2);
    const out = prepareForTrace(enorme, { sensitive: true });
    expect(out).toMatchObject({ redacted: true });
    expect(out).not.toHaveProperty('__truncated');
  });
});

describe('Trace', () => {
  it('assegna seq monotoni e gap-free', () => {
    const trace = fisso();
    trace.append({ type: 'run.start', runId: 'r1', messages: [], tools: [] });
    trace.append({ type: 'step.start', step: 0 });
    trace.append({ type: 'step.start', step: 1 });
    expect(trace.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('filtra per tipo, mantenendo l’ordine', () => {
    const trace = fisso();
    trace.append({ type: 'step.start', step: 0 });
    trace.append({ type: 'policy.request', step: 0, model: 'm', messageCount: 1 });
    trace.append({ type: 'step.start', step: 1 });
    expect(trace.of('step.start').map((e) => e.step)).toEqual([0, 1]);
  });

  it('JSONL: una riga per evento, e il ritorno all’identico', () => {
    const trace = fisso();
    trace.append({ type: 'run.start', runId: 'r1', messages: [{ role: 'user', content: 'ciao' }], tools: ['a'] });
    trace.append({ type: 'run.end', steps: 0, stopReason: 'end_turn', spent: 0, spentUsd: '0.000000' });

    const righe = trace.toJSONL().split('\n');
    expect(righe).toHaveLength(2);
    expect(JSON.parse(righe[1] as string).stopReason).toBe('end_turn');

    const riletta = Trace.parse(trace.toJSONL());
    expect(riletta.normalized()).toEqual(trace.normalized());
  });

  it('una riga malformata è un errore, non un buco silenzioso', () => {
    const trace = fisso();
    trace.append({ type: 'run.start', runId: 'r1', messages: [], tools: [] });
    expect(() => Trace.parse(`${trace.toJSONL()}\n{rotto`)).toThrow(SyntaxError);
    expect(() => Trace.parse(`${trace.toJSONL()}\n{rotto`)).toThrow(/riga 2/);
  });

  it('tolera una riga vuota in coda', () => {
    expect(Trace.parse('{"seq":0,"ts":0,"type":"step.start","step":0}\n\n').length).toBe(1);
  });

  it('normalized() toglie il tempo ma lascia la posizione', () => {
    const a = fisso();
    a.append({ type: 'step.start', step: 0 });
    const b = new Trace({ clock: () => 999 });
    b.append({ type: 'step.start', step: 0 });
    expect(a.normalized()).toEqual(b.normalized());
    expect(a.normalized()).not.toEqual(b.events);
  });

  it('un orologio deterministico rende due tracce identiche byte per byte', () => {
    const costruisci = (): Trace => {
      const t = fisso();
      t.append({ type: 'step.start', step: 0 });
      return t;
    };
    expect(costruisci().toJSONL()).toBe(costruisci().toJSONL());
  });
});

describe('traceableCall', () => {
  it('gli argomenti di un tool sensibile non arrivano in traccia', () => {
    const call = traceableCall({ id: 'c1', name: 'leggi_paziente', args: { cf: 'RSSMRA80A01H501U' } }, true);
    expect(call.args).toEqual({ redacted: true, bytes: JSON.stringify({ cf: 'RSSMRA80A01H501U' }).length });
    expect(JSON.stringify(call)).not.toContain('RSSMRA80A01H501U');
  });

  it('un tool normale scrive gli argomenti per intero', () => {
    const call = traceableCall({ id: 'c1', name: 'somma', args: { a: 1 } }, false);
    expect(call.args).toEqual({ a: 1 });
  });
});