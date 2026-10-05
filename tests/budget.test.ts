import { describe, expect, it } from 'vitest';

import { Budget, costOf, formatUsd, micros, usd, UNKNOWN_MODEL } from '../src/budget.js';
import { BudgetExceededError } from '../src/errors.js';

describe('money units', () => {
  it('converts dollars into micro-dollars with no loss', () => {
    expect(usd(0.25)).toBe(250_000);
    expect(usd(1)).toBe(1_000_000);
    expect(formatUsd(micros(1234))).toBe('0.001234');
  });

  it('rejects values that are not money', () => {
    expect(() => usd(Number.NaN)).toThrow(TypeError);
    expect(() => usd(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => usd(-1)).toThrow(RangeError);
  });
});

describe('costOf', () => {
  it('computes on the price per million tokens', () => {
    // 1M input tokens at 3 µUSD/M + 1M output at 15 µUSD/M = 18 µUSD
    const price = { input: micros(3), output: micros(15) };
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price)).toBe(18);
  });

  it('rounds up: never under, never on credit', () => {
    const price = { input: micros(3), output: micros(15) };
    // 1 token at 3 µUSD/M = 0.000003 µUSD: it must become 1, not 0
    expect(costOf({ inputTokens: 1, outputTokens: 0 }, price)).toBe(1);
    expect(costOf({ inputTokens: 0, outputTokens: 1 }, price)).toBe(1);
  });

  it('loses no precision where a float would fail', () => {
    // 0.1 + 0.2 !== 0.3 in float: in integer micro-dollars the sum works out
    const sum = usd(0.1) + usd(0.2);
    expect(sum).toBe(usd(0.3));
    expect(sum === 0.3 * 1_000_000).toBe(true);
  });

  it('rejects negative or non-finite tokens', () => {
    expect(() => costOf({ inputTokens: -1, outputTokens: 0 }, UNKNOWN_MODEL)).toThrow(RangeError);
    expect(() => costOf({ inputTokens: Number.NaN, outputTokens: 0 }, UNKNOWN_MODEL)).toThrow(TypeError);
  });
});

describe('Budget: reserve, then settle', () => {
  it('clean start', () => {
    const b = new Budget(usd(1));
    expect(b.spent).toBe(0);
    expect(b.held).toBe(0);
    expect(b.available).toBe(usd(1));
  });

  it('a reservation locks the money until settlement', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.4));
    expect(b.held).toBe(usd(0.4));
    expect(b.available).toBe(usd(0.6));
    expect(b.spent).toBe(0);

    b.settle(r, usd(0.3));
    expect(b.held).toBe(0);
    expect(b.spent).toBe(usd(0.3));
    expect(b.available).toBe(usd(0.7));
  });

  it('an overestimated reservation does not burn money', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.9));
    b.settle(r, micros(1));
    expect(b.spent).toBe(1);
    expect(b.available).toBe(usd(1) - 1);
  });

  it('release frees without spending', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.5));
    b.release(r);
    expect(b.held).toBe(0);
    expect(b.spent).toBe(0);
  });

  it('going over the cap fails BEFORE the spending', () => {
    const b = new Budget(usd(1));
    b.reserve(usd(0.8));
    expect(() => b.reserve(usd(0.3))).toThrow(BudgetExceededError);
    // and the money did not move
    expect(b.spent).toBe(0);
    expect(b.available).toBe(usd(0.2));
  });

  it('the budget error says how much was needed and how much was there', () => {
    const b = new Budget(usd(1));
    try {
      b.reserve(usd(2));
      expect.unreachable('it was supposed to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const e = error as BudgetExceededError;
      expect(e.requested).toBe(usd(2));
      expect(e.available).toBe(usd(1));
    }
  });

  it('a reservation is touched once only', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.1));
    b.settle(r, usd(0.1));
    expect(() => b.settle(r, usd(0.1))).toThrow(/touched once only/);
    expect(() => b.release(r)).toThrow(/touched once only/);
  });

  it('open reservations are visible: a forgotten one is a visible bug', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.1));
    expect(b.openReservations).toEqual([r.id]);
    b.settle(r, usd(0.1));
    expect(b.openReservations).toEqual([]);
  });

  it('canAfford reserves nothing', () => {
    const b = new Budget(usd(1));
    expect(b.canAfford(usd(1))).toBe(true);
    expect(b.canAfford(micros(usd(1) + 1))).toBe(false);
    expect(b.held).toBe(0);
  });

  it('the snapshot tells the whole picture', () => {
    const b = new Budget(usd(2));
    b.reserve(usd(0.5));
    expect(b.snapshot()).toEqual({
      limit: usd(2),
      spent: 0,
      held: usd(0.5),
      available: usd(1.5),
    });
  });
});

describe('Budget: cap never overrun in the sum', () => {
  it('a thousand equal reservations do not sum past the cap', () => {
    const b = new Budget(micros(1000));
    const accepted: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      try {
        accepted.push(b.reserve(micros(1)).id);
      } catch {
        break;
      }
    }
    expect(accepted).toHaveLength(1000);
    expect(b.held).toBe(micros(1000));
    expect(b.available).toBe(0);
  });
});
