/**
 * La traccia: il log di un run, in sola aggiunta.
 *
 * Non è un file di log. Un log dice "cosa è successo" in formato leggibile; la
 * traccia dice "cosa è successo" in un formato che si può **rileggere e su cui si
 * può scrivere un test** (ADR 0001). Per questo ogni evento è un valore JSON senza
 * campi impilabili e senza orari obbligatori: due esecuzioni della stessa conversazione
 * producono tracce identiche salvo il tempo.
 *
 * Tre problemi che una traccia naïve sbaglia, e come sono risolti qui:
 *
 * - **i dati personali finiscono in traccia.** Un tool che legge un profilo utente
 *   scrive nel log ciò che ha letto. I tool che lo fatti si dichiarano `sensitive`
 *   e i loro argomenti e risultati finiscono redatti: resta la dimensione, non il
 *   contenuto.
 * - **un output non serializzabile fa esplodere il logging.** Un tool può restituire
 *   una classe, un `Map`, o qualcosa con un ciclo. `toTraceable` non fallisce mai:
 *   degrada e dice che ha degradato.
 * - **un output enorme fa esplodere il file.** Troncamento con il conto esatto di
 *   cosa è stato tagliato, perché una traccia che mente sembrando completa è peggio
 *   di una assente.
 */

import type { Decision, Message, StopReason, ToolCall, ToolFailure, Usage } from './types.js';

/** Campi comuni a ogni evento. */
interface TraceBase {
  /** Posizione nella traccia. Monotono, gap-free: un buco significa una perdita. */
  readonly seq: number;
  /** Unix ms. Presente per l'analisi, **ignorato** dal confronto di replay. */
  readonly ts: number;
}

/** Tutti gli eventi che un run può produrre. */
export type TraceEvent =
  | (TraceBase & { type: 'run.start'; runId: string; messages: readonly Message[]; tools: readonly string[] })
  | (TraceBase & { type: 'step.start'; step: number })
  | (TraceBase & { type: 'policy.request'; step: number; model: string; messageCount: number })
  | (TraceBase & { type: 'policy.response'; step: number; model: string; usage: Usage; decision: Decision })
  | (TraceBase & { type: 'tool.call'; step: number; call: TraceableToolCall; sensitive: boolean; fingerprint?: string })
  | (TraceBase & { type: 'tool.result'; step: number; callId: string; tool: string; outcome: ToolOutcomeTrace })
  | (TraceBase & { type: 'budget.settle'; step: number; reserved: number; actual: number })
  | (TraceBase & { type: 'run.end'; steps: number; stopReason: StopReason; spent: number; spentUsd: string });

/** Una chiamata a tool, con gli argomenti già passati da `toTraceable`. */
export interface TraceableToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** Esito di un tool, in forma tracciabile. */
export type ToolOutcomeTrace =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly failure: ToolFailure };

/** Come si presenta un valore che si è deciso di non scrivere. */
export interface Redacted {
  readonly redacted: true;
  /** Byte stimati del valore originale: serve per capire quanto era grande. */
  readonly bytes: number;
}

/** Come si presenta un valore troncato. */
export interface Truncated {
  readonly truncated: true;
  readonly bytes: number;
  readonly keptBytes: number;
}

/**
 * `Omit` distribuito sulle unioni.
 *
 * Il `Omit` di TypeScript applicato a una unione **non** distribuisce: si applica
 * all'unione nel suo complesso e ne cancella le chiavi che non sono comuni a tutte
 * le varianti. `Omit<TraceEvent, 'seq' | 'ts'>` diventerebbe `{ type: string }` e
 * `append({ type: 'step.start', step: 0 })` non compilerebbe. Qui ogni variante
 * perde i propri due campi e le altre chiavi restano intatte.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** Un evento come lo fornisce il chiamante: senza `seq`, che assegna la traccia. */
export type TraceInput = DistributiveOmit<TraceEvent, 'seq' | 'ts'>;

/** Soglia oltre la quale un valore viene tagliato. 64 KiB: abbondante per un tool. */
export const MAX_TRACE_VALUE_BYTES = 64 * 1024;

/**
 * Converte qualsiasi valore in qualcosa di scrivibile in JSON, senza fallire mai.
 *
 * Un `Error` diventa `{ name, message }`: il resto dello stack è rumore per la
 * traccia e spesso contiene path assoluti. I valori non serializzabili diventano
 * la loro descrizione tipo, marcata come degradata.
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
  if (kind === 'number') return Number.isFinite(value) ? value : { degraded: `${kind}: ${String(value)}` };
  if (kind === 'bigint') return { degraded: `bigint: ${String(value)}` };
  if (kind === 'function') return { degraded: `function: ${(value as { name?: string }).name || 'anonima'}` };
  if (kind === 'symbol') return { degraded: `symbol: ${String(value)}` };

  const object = value as object;
  if (seen.has(object)) return { degraded: 'ciclo' };
  if (depth > 12) return { degraded: 'profondità massima' };

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

/** Applica la ridazione a un valore, restituendo solo la sua dimensione. */
export function redact(value: unknown): Redacted {
  let bytes = 0;
  try {
    bytes = JSON.stringify(toTraceable(value))?.length ?? 0;
  } catch {
    bytes = -1;
  }
  return { redacted: true, bytes };
}

/**
 * Prepara un valore per la traccia: ridazione se richiesta, troncamento se grande.
 *
 * I due controlli sono in quest'ordine perché il ridatto non va troncato: dire
 * "questo era enorme" è un fatto utile, dirlo a metà no.
 */
export function prepareForTrace(
  value: unknown,
  options: { sensitive: boolean },
): unknown {
  if (options.sensitive) return redact(value);

  const safe = toTraceable(value);
  let json: string;
  try {
    json = JSON.stringify(safe) ?? 'null';
  } catch {
    return { degraded: 'non serializzabile' };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= MAX_TRACE_VALUE_BYTES) return safe;

  return { ...(safe as Record<string, unknown>), __truncated: { truncated: true, bytes, keptBytes: MAX_TRACE_VALUE_BYTES } satisfies Truncated };
}

/**
 * Il log in sola aggiunta.
 *
 * "In sola aggiunta" è una proprietà strutturale, non una promessa: esiste solo
 * `append`, non esiste `remove` né `update`. Un test può riordinare il codice e
 * ritrovarsi con un edit di una traccia esistente solo cercandolo, e non lo troverà.
 */
export class Trace {
  readonly #events: TraceEvent[] = [];
  readonly #clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  /** Aggiunge un evento. Il `seq` è assegnato qui e non è negoziabile. */
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

  /** Gli eventi di un tipo, in ordine. */
  of<T extends TraceEvent['type']>(type: T): Extract<TraceEvent, { type: T }>[] {
    return this.#events.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type);
  }

  /** Ultimo evento, se c'è. */
  get last(): TraceEvent | undefined {
    return this.#events.at(-1);
  }

  /** Serializza in JSONL: un evento per riga, nessuna riga vuota in coda. */
  toJSONL(): string {
    return this.#events.map((event) => JSON.stringify(event)).join('\n');
  }

  /** Rilegge da JSONL. Una riga malformata è un errore, non un buco silenzioso. */
  static parse(source: string): Trace {
    const trace = new Trace({ clock: () => 0 });
    const lines = source.split('\n').filter((line) => line.trim() !== '');
    for (const [index, line] of lines.entries()) {
      try {
        trace.#events.push(JSON.parse(line) as TraceEvent);
      } catch (error) {
        throw new SyntaxError(`riga ${index + 1} della traccia non è JSON valido: ${String(error)}`);
      }
    }
    return trace;
  }

  /**
   * Proiezione senza `ts`, per confrontare due run.
   *
   * Due esecuzioni della stessa conversazione hanno tempi diversi per definizione:
   * confrontarle è utile proprio perché tutto il resto deve coincidere. `seq` resta,
   * perché indica la posizione e quella deve essere la stessa.
   */
  normalized(): unknown[] {
    return this.#events.map(({ ts: _ts, ...rest }) => rest);
  }
}

/** Costruisce una `TraceableToolCall` da una `ToolCall`, passando per la ridazione. */
export function traceableCall(call: ToolCall, sensitive: boolean): TraceableToolCall {
  return { id: call.id, name: call.name, args: prepareForTrace(call.args, { sensitive }) };
}