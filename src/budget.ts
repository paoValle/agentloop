/**
 * Il budget: quanti soldi può spendere questo run, e come fa a non spenderne di più.
 *
 * Il problema che risolve è una domanda operativa, non accademica: un agentic loop
 * che chiama un tool che a sua volta chiama un provider a pagamento può, in teoria,
 * continuare a farlo finché non esaurisce la carta. Un budget che si verifica **dopo**
 * la chiamata è già troppo tardi: il denaro è andato.
 *
 * Per questo il modello è **prenota → salda**:
 *
 *   1. `reserve(estimate)` blocca subito la somma stimata. Se non entra nel
 *      budget, la decisione non viene neppure eseguita e non costa nulla.
 *   2. la chiamata avviene davvero.
 *   3. `settle(handle, actual)` sostituisce la stima con il consumo reale, e
 *      libera il resto.
 *
 * In questo modo il tetto vale **davanti** alla spesa, non dopo.
 *
 * I soldi sono interi in **micro-dollari** (µUSD). Nessun `float`: `0.1 + 0.2 !== 0.3`
 * e su un fatturato la differenza è un buco. Vedi il riquadro in fondo.
 */

import { BudgetExceededError } from './errors.js';
import type { Usage } from './types.js';

/** Un dollaro, in micro-dollari. */
export const MICRO_USD_PER_USD = 1_000_000;

/** Token in un milione: l'unità in cui i prezzi vengono pubblicati. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Un importo in micro-dollari. Tipo marchiato: non è un numero qualsiasi.
 *
 * Serve a rendere impossibile, in compilazione, il classico bug di passare
 * dollari dove si aspettavano micro-dollari — che è un errore di 10⁶, invisibile
 * nei test e devastante in produzione.
 */
export type MicroUsd = number & { readonly __unit?: 'MicroUsd' };

/** Costruisce un `MicroUsd` da dollari (`0.25` → `250_000` µUSD). */
export function usd(amount: number): MicroUsd {
  return assertNonNegativeFinite(amount * MICRO_USD_PER_USD) as MicroUsd;
}

/** Costruisce un `MicroUsd` da micro-dollari già espressi. */
export function micros(amount: number): MicroUsd {
  return assertNonNegativeFinite(amount) as MicroUsd;
}

/** Formatta per la traccia e per i log: `0.001234`. */
export function formatUsd(value: MicroUsd): string {
  return (value / MICRO_USD_PER_USD).toFixed(6);
}

/** Prezzo di un modello, in µUSD per milione di token. */
export interface Price {
  readonly input: MicroUsd;
  readonly output: MicroUsd;
}

/** Tabella dei prezzi indicati per modello: `{'gpt-4o': { input, output }, ...}`. */
export type PriceTable = Readonly<Record<string, Price>>;

/** Il prezzo di un modello esplicitamente dichiarato dal chiamante. */
export const UNKNOWN_MODEL: Price = { input: micros(0), output: micros(0) };

/**
 * Costo di una chiamata, in µUSD, **arrotondato per eccesso**.
 *
 * L'arrotondamento è deliberato: se si arrotondasse all'ultimo, il tetto di budget
 * potrebbe essere scavalcato dalla somma di tanti arrotondamenti per difetto. Un
 * errore di una unità di micro-dollari a favore del sistema costa meno di una
 * fattura che nessuno riesce a spiegare.
 */
export function costOf(usage: Usage, price: Price): MicroUsd {
  const { inputTokens, outputTokens } = usage;
  assertNonNegativeFinite(inputTokens);
  assertNonNegativeFinite(outputTokens);
  const cost =
    (Math.ceil(inputTokens) * price.input + Math.ceil(outputTokens) * price.output) /
    TOKENS_PER_PRICE_UNIT;
  return Math.ceil(cost) as MicroUsd;
}

/**
 * Una prenotazione. Va **sempre** saldata o liberata: una prenotazione dimenticata
 * blocca budget per il resto del run.
 */
export interface Reservation {
  readonly id: number;
  /** Somma bloccata, in µUSD. */
  readonly amount: MicroUsd;
}

/**
 * Il tetto di spesa di un run.
 *
 * Istanza singola per run. Non è pensato per essere condiviso: la concorrenza su un
 * budget condiviso è un problema di distributed systems, non di una libreria.
 */
export class Budget {
  #limit: MicroUsd;
  #committed: MicroUsd = 0;
  #reserved: MicroUsd = 0;
  #nextId = 1;
  #open = new Map<number, MicroUsd>();

  constructor(limit: MicroUsd) {
    this.#limit = assertNonNegativeFinite(limit) as MicroUsd;
  }

  /**
   * Un tetto che in pratica non esiste, dichiarato apertamente.
   *
   * Serve a due cose: ai test, che non hanno bisogno di fare i conti, e a chi *sa*
   * che il run è economico. Il punto è che sia una **scelta** e non un default:
   * `budget: new Budget(...)` rende la decisione leggibile in ogni diff.
   */
  static unlimited(): Budget {
    return new Budget(Number.MAX_SAFE_INTEGER as MicroUsd);
  }

  /** Il tetto. */
  get limit(): MicroUsd {
    return this.#limit;
  }

  /** Denaro effettivamente speso finora (esclude le prenotazioni aperte). */
  get spent(): MicroUsd {
    return this.#committed;
  }

  /** Denaro attualmente bloccato da prenotazioni aperte. */
  get held(): MicroUsd {
    return this.#reserved;
  }

  /** Quanto si può ancora prenotare: tetto meno speso meno bloccato. */
  get available(): MicroUsd {
    return (this.#limit - this.#committed - this.#reserved) as MicroUsd;
  }

  /** Prenotazioni ancora da saldare. Se resta una a metà run, è un bug. */
  get openReservations(): readonly number[] {
    return [...this.#open.keys()];
  }

  /** `true` se la somma entra nel budget residuo. Non prenota nulla. */
  canAfford(amount: MicroUsd): boolean {
    return amount <= this.available;
  }

  /**
   * Blocca `amount` e restituisce la prenotazione.
   *
   * @throws {BudgetExceededError} se non entra nel residuo. **Prima** di spendere.
   */
  reserve(amount: MicroUsd): Reservation {
    const value = assertNonNegativeFinite(amount) as MicroUsd;
    if (value > this.available) {
      throw new BudgetExceededError(value, this.available);
    }
    const id = this.#nextId++;
    this.#reserved += value;
    this.#open.set(id, value);
    return { id, amount: value };
  }

  /**
   * Salda la prenotazione con il consumo reale.
   *
   * Se il reale supera lo stimato, il debito resta intero: si può andare leggermente
   * oltre il tetto (i prezzi cambiano fra un preventivo e la fattura) ma non di una
   * somba, e soprattutto non di un ordine di grandezza.
   */
  settle(reservation: Reservation, actual: MicroUsd): void {
    const held = this.#take(reservation);
    const value = assertNonNegativeFinite(actual) as MicroUsd;
    this.#reserved -= held;
    this.#committed += value;
  }

  /** Rilascia la prenotazione senza spendere: la stima si è rivelata sovrastimata. */
  release(reservation: Reservation): void {
    const held = this.#take(reservation);
    this.#reserved -= held;
  }

  /** Dettaglio per traccia e log. */
  snapshot(): { limit: MicroUsd; spent: MicroUsd; held: MicroUsd; available: MicroUsd } {
    return {
      limit: this.limit,
      spent: this.spent,
      held: this.held,
      available: this.available,
    };
  }

  #take(reservation: Reservation): MicroUsd {
    const held = this.#open.get(reservation.id);
    if (held === undefined) {
      throw new Error(
        `prenotazione ${reservation.id} già saldata o liberata: una prenotazione si tocca una volta sola`,
      );
    }
    this.#open.delete(reservation.id);
    return held;
  }
}

function assertNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`atteso un numero finito, ricevuto ${String(value)}`);
  }
  if (value < 0) {
    throw new RangeError(`atteso un valore non negativo, ricevuto ${value}`);
  }
  return value;
}