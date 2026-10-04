import { describe, expect, it } from 'vitest';

import { Budget, costOf, formatUsd, micros, usd, UNKNOWN_MODEL } from '../src/budget.js';
import { BudgetExceededError } from '../src/errors.js';

describe('unità di denaro', () => {
  it('converte dollari in micro-dollari senza perdite', () => {
    expect(usd(0.25)).toBe(250_000);
    expect(usd(1)).toBe(1_000_000);
    expect(formatUsd(micros(1234))).toBe('0.001234');
  });

  it('rifiuta valori che non sono soldi', () => {
    expect(() => usd(Number.NaN)).toThrow(TypeError);
    expect(() => usd(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => usd(-1)).toThrow(RangeError);
  });
});

describe('costOf', () => {
  it('calcola sul prezzo per milione di token', () => {
    // 1M token input a 3 µUSD/M + 1M output a 15 µUSD/M = 18 µUSD
    const price = { input: micros(3), output: micros(15) };
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price)).toBe(18);
  });

  it('arrotonda per eccesso: mai sotto, mai a credito', () => {
    const price = { input: micros(3), output: micros(15) };
    // 1 token da 3 µUSD/M = 0.000003 µUSD: deve diventare 1, non 0
    expect(costOf({ inputTokens: 1, outputTokens: 0 }, price)).toBe(1);
    expect(costOf({ inputTokens: 0, outputTokens: 1 }, price)).toBe(1);
  });

  it('non perde precisione dove il float fallirebbe', () => {
    // 0.1 + 0.2 !== 0.3 in float: in micro-dollari interi la somma torna
    const sum = usd(0.1) + usd(0.2);
    expect(sum).toBe(usd(0.3));
    expect(sum === 0.3 * 1_000_000).toBe(true);
  });

  it('rifiuta token negativi o non finiti', () => {
    expect(() => costOf({ inputTokens: -1, outputTokens: 0 }, UNKNOWN_MODEL)).toThrow(RangeError);
    expect(() => costOf({ inputTokens: Number.NaN, outputTokens: 0 }, UNKNOWN_MODEL)).toThrow(TypeError);
  });
});

describe('Budget: prenota, poi salda', () => {
  it('partenza pulita', () => {
    const b = new Budget(usd(1));
    expect(b.spent).toBe(0);
    expect(b.held).toBe(0);
    expect(b.available).toBe(usd(1));
  });

  it('una prenotazione blocca il denaro fino al saldo', () => {
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

  it('la stima sovrastimata non brucia denaro', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.9));
    b.settle(r, micros(1));
    expect(b.spent).toBe(1);
    expect(b.available).toBe(usd(1) - 1);
  });

  it('release libera senza spendere', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.5));
    b.release(r);
    expect(b.held).toBe(0);
    expect(b.spent).toBe(0);
  });

  it('superare il tetto fallisce PRIMA della spesa', () => {
    const b = new Budget(usd(1));
    b.reserve(usd(0.8));
    expect(() => b.reserve(usd(0.3))).toThrow(BudgetExceededError);
    // e il denaro non si è mosso
    expect(b.spent).toBe(0);
    expect(b.available).toBe(usd(0.2));
  });

  it("l'errore di budget dice quanto serviva e quanto c'era", () => {
    const b = new Budget(usd(1));
    try {
      b.reserve(usd(2));
      expect.unreachable('doveva lanciare');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetExceededError);
      const e = error as BudgetExceededError;
      expect(e.requested).toBe(usd(2));
      expect(e.available).toBe(usd(1));
    }
  });

  it('una prenotazione si tocca una volta sola', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.1));
    b.settle(r, usd(0.1));
    expect(() => b.settle(r, usd(0.1))).toThrow(/una volta sola/);
    expect(() => b.release(r)).toThrow(/una volta sola/);
  });

  it('le prenotazioni aperte sono visibili: una dimenticata è un bug visibile', () => {
    const b = new Budget(usd(1));
    const r = b.reserve(usd(0.1));
    expect(b.openReservations).toEqual([r.id]);
    b.settle(r, usd(0.1));
    expect(b.openReservations).toEqual([]);
  });

  it('canAfford non prenota nulla', () => {
    const b = new Budget(usd(1));
    expect(b.canAfford(usd(1))).toBe(true);
    expect(b.canAfford(usd(1) + 1)).toBe(false);
    expect(b.held).toBe(0);
  });

  it('lo snapshot racconta il quadro completo', () => {
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

describe('Budget: tetto mai scavalcato nella somma', () => {
  it('mille prenotazioni uguali non sommano oltre il tetto', () => {
    const b = new Budget(micros(1000));
    const accepted: number[] = [];
    for (let i = 0; i < 10_000; i++) {
      try {
        accepted.push(b.reserve(1).id);
      } catch {
        break;
      }
    }
    expect(accepted).toHaveLength(1000);
    expect(b.held).toBe(micros(1000));
    expect(b.available).toBe(0);
  });
});