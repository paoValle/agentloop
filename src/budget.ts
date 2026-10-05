/**
 * The budget: how much money this run may spend, and how it avoids spending more.
 *
 * The problem it solves is an operational question, not an academic one: an agentic
 * loop that calls a tool which in turn calls a paid provider can, in theory, keep
 * doing that until the card is empty. A budget checked **after** the call is already
 * too late: the money is gone.
 *
 * That is why the model is **reserve → settle**:
 *
 *   1. `reserve(estimate)` locks the estimated amount right away. If it does not fit
 *      the budget, the decision is not even executed and costs nothing.
 *   2. the call actually happens.
 *   3. `settle(handle, actual)` replaces the estimate with the real consumption, and
 *      releases the rest.
 *
 * This way the cap holds **in front of** the spend, not after it.
 *
 * Money is integer **micro-dollars** (µUSD). No `float`: `0.1 + 0.2 !== 0.3`
 * and on an invoice the difference is a hole.
 */

import { BudgetExceededError } from './errors.js';
import type { Usage } from './types.js';

/** One dollar, in micro-dollars. */
export const MICRO_USD_PER_USD = 1_000_000;

/** Tokens in a million: the unit prices are published in. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * An amount in micro-dollars. Branded type: it is not just any number.
 *
 * The brand has a **required** property: that is what makes `number` non-assignable
 * to `MicroUsd`. With an optional property the type would brand nothing — `number`
 * would stay compatible and the bug it is meant to prevent (passing dollars where
 * micro-dollars were expected, an error of 10⁶) would come back exactly the same.
 */
export type MicroUsd = number & { readonly __unit: 'MicroUsd' };

/** Builds a `MicroUsd` from dollars (`0.25` → `250_000` µUSD). */
export function usd(amount: number): MicroUsd {
  return assertNonNegativeFinite(amount * MICRO_USD_PER_USD) as MicroUsd;
}

/** Builds a `MicroUsd` from micro-dollars already expressed. */
export function micros(amount: number): MicroUsd {
  return assertNonNegativeFinite(amount) as MicroUsd;
}

/** Formats for the trace and for logs: `0.001234`. */
export function formatUsd(value: MicroUsd): string {
  return (value / MICRO_USD_PER_USD).toFixed(6);
}

/** Price of a model, in µUSD per million tokens. */
export interface Price {
  readonly input: MicroUsd;
  readonly output: MicroUsd;
}

/** Price table indexed by model: `{'gpt-4o': { input, output }, ...}`. */
export type PriceTable = Readonly<Record<string, Price>>;

/** The price of a model not explicitly declared by the caller. */
export const UNKNOWN_MODEL: Price = { input: micros(0), output: micros(0) };

/**
 * Cost of a call, in µUSD, **rounded up**.
 *
 * The rounding is deliberate: rounding to the nearest unit would let the budget cap
 * be bypassed by the sum of many roundings down. A one micro-dollar error in the
 * system's favor costs less than an invoice nobody can explain.
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
 * A reservation. It must **always** be settled or released: a forgotten reservation
 * locks budget for the rest of the run.
 */
export interface Reservation {
  readonly id: number;
  /** Locked amount, in µUSD. */
  readonly amount: MicroUsd;
}

/**
 * The spending cap of a run.
 *
 * One instance per run. It is not meant to be shared: concurrency on a shared budget
 * is a distributed systems problem, not a library one.
 */
export class Budget {
  #limit: MicroUsd;
  #committed: MicroUsd = micros(0);
  #reserved: MicroUsd = micros(0);
  #nextId = 1;
  #open = new Map<number, MicroUsd>();

  constructor(limit: MicroUsd) {
    this.#limit = assertNonNegativeFinite(limit) as MicroUsd;
  }

  /**
   * A cap that in practice does not exist, declared openly.
   *
   * It serves two purposes: tests, which do not need to do the math, and whoever
   * *knows* the run is cheap. The point is that it is a **choice** and not a default:
   * `budget: new Budget(...)` makes the decision readable in every diff.
   */
  static unlimited(): Budget {
    return new Budget(Number.MAX_SAFE_INTEGER as MicroUsd);
  }

  /** The cap. */
  get limit(): MicroUsd {
    return this.#limit;
  }

  /** Money actually spent so far (excludes open reservations). */
  get spent(): MicroUsd {
    return this.#committed;
  }

  /** Money currently locked by open reservations. */
  get held(): MicroUsd {
    return this.#reserved;
  }

  /** How much can still be reserved: cap minus spent minus held. */
  get available(): MicroUsd {
    return (this.#limit - this.#committed - this.#reserved) as MicroUsd;
  }

  /** Reservations still to be settled. If one is left mid-run, it is a bug. */
  get openReservations(): readonly number[] {
    return [...this.#open.keys()];
  }

  /** `true` if the amount fits the remaining budget. Reserves nothing. */
  canAfford(amount: MicroUsd): boolean {
    return amount <= this.available;
  }

  /**
   * Locks `amount` and returns the reservation.
   *
   * @throws {BudgetExceededError} if it does not fit the remainder. **Before** spending.
   */
  reserve(amount: MicroUsd): Reservation {
    const value = assertNonNegativeFinite(amount) as MicroUsd;
    if (value > this.available) {
      throw new BudgetExceededError(value, this.available);
    }
    const id = this.#nextId++;
    this.#reserved = (this.#reserved + value) as MicroUsd;
    this.#open.set(id, value);
    return { id, amount: value };
  }

  /**
   * Settles the reservation with the real consumption.
   *
   * If the real amount exceeds the estimate, the debt stays whole: the cap can be
   * exceeded slightly (prices change between a quote and an invoice) but not by an
   * order of magnitude.
   */
  settle(reservation: Reservation, actual: MicroUsd): void {
    const held = this.#take(reservation);
    const value = assertNonNegativeFinite(actual) as MicroUsd;
    this.#reserved = (this.#reserved - held) as MicroUsd;
    this.#committed = (this.#committed + value) as MicroUsd;
  }

  /** Releases the reservation without spending: the estimate turned out too high. */
  release(reservation: Reservation): void {
    const held = this.#take(reservation);
    this.#reserved = (this.#reserved - held) as MicroUsd;
  }

  /** Detail for trace and logs. */
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
        `reservation ${reservation.id} already settled or released: a reservation is touched once only`,
      );
    }
    this.#open.delete(reservation.id);
    return held;
  }
}

function assertNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`expected a finite number, received ${String(value)}`);
  }
  if (value < 0) {
    throw new RangeError(`expected a non-negative value, received ${value}`);
  }
  return value;
}
