import { describe, it, expect } from 'vitest';
import { clamp, D, Money, bps, ratio, sumMoney, scaleOf } from '../src/index.js';

describe('Money', () => {
  it('keeps exact decimal arithmetic where floats would drift', () => {
    // The canonical float failure: 0.1 + 0.2 !== 0.3
    const a = Money.of('0.1', 'USD');
    const b = Money.of('0.2', 'USD');
    expect(a.plus(b).toString()).toBe('0.3');
    expect(a.plus(b).eq(Money.of('0.3', 'USD'))).toBe(true);
  });

  it('survives a thousand cent additions without drift', () => {
    let total = Money.zero('USD');
    for (let i = 0; i < 1000; i++) total = total.plus(Money.of('0.01', 'USD'));
    expect(total.toFixedString()).toBe('10.00');
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of('1', 'USD').plus(Money.of('1', 'EUR'))).toThrow(/currency mismatch/);
    expect(() => Money.of('1', 'USD').gt(Money.of('1', 'EUR'))).toThrow(/currency mismatch/);
  });

  it('rejects non-finite input rather than producing NaN money', () => {
    expect(() => Money.of(Number.NaN, 'USD')).toThrow(TypeError);
    expect(() => Money.of(Number.POSITIVE_INFINITY, 'USD')).toThrow(TypeError);
  });

  it('refuses division by zero instead of returning Infinity', () => {
    expect(() => Money.of('10', 'USD').dividedBy(0)).toThrow(RangeError);
  });

  it('rounds credit down and debt up', () => {
    expect(Money.of('100.567', 'USD').roundDown().toFixedString()).toBe('100.56');
    expect(Money.of('100.561', 'USD').roundUp().toFixedString()).toBe('100.57');
  });

  it('uses banker\'s rounding so repeated halves do not bias upward', () => {
    expect(Money.of('2.345', 'USD').round().toFixedString()).toBe('2.34');
    expect(Money.of('2.355', 'USD').round().toFixedString()).toBe('2.36');
  });

  it('rounds limits down to a clean step', () => {
    expect(Money.of('147832.91', 'USD').roundDownToStep('1000').toFixedString()).toBe('147000.00');
    expect(Money.of('999', 'USD').roundDownToStep('1000').toFixedString()).toBe('0.00');
  });

  it('respects per-currency minor units', () => {
    expect(scaleOf('JPY')).toBe(0);
    expect(scaleOf('BTC')).toBe(8);
    expect(Money.of('1234.6', 'JPY').toFixedString()).toBe('1235');
    expect(Money.of('0.123456789', 'BTC').toFixedString()).toBe('0.12345679');
  });

  it('clamps negatives to zero for available-credit style values', () => {
    expect(Money.of('-50', 'USD').clampPositive().toFixedString()).toBe('0.00');
    expect(Money.of('50', 'USD').clampPositive().toFixedString()).toBe('50.00');
  });

  it('returns null rather than Infinity for a zero denominator', () => {
    expect(ratio(Money.of('100', 'USD'), Money.zero('USD'))).toBeNull();
    expect(ratio(Money.of('50', 'USD'), Money.of('200', 'USD'))!.toFixed()).toBe('0.25');
  });

  it('sums an empty list to zero of the requested currency', () => {
    expect(sumMoney([], 'EUR').toFixedString()).toBe('0.00');
    expect(sumMoney([Money.of('1.11', 'EUR'), Money.of('2.22', 'EUR')], 'EUR').toFixedString()).toBe('3.33');
  });

  it('converts basis points and clamps', () => {
    expect(bps(250).toFixed()).toBe('0.025');
    expect(clamp('1.5', '0', '1').toFixed()).toBe('1');
    expect(clamp('-0.5', '0', '1').toFixed()).toBe('0');
    expect(() => clamp('0.5', '1', '0')).toThrow(RangeError);
  });

  it('serialises at the currency scale, not full precision', () => {
    const m = Money.of('1234.5678901', 'USD');
    expect(m.toJSON()).toEqual({ amount: '1234.57', currency: 'USD' });
    expect(m.toString()).toBe('1234.5678901');
  });

  it('handles very large BTC-scale values without precision loss', () => {
    const qty = D('21000000');
    const price = D('987654.32109876');
    const value = Money.of(qty.times(price), 'USD');
    expect(value.toString()).toBe('20740740743073.96');
  });
});
