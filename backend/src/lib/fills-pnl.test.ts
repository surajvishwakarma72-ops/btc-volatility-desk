import { describe, expect, it } from 'vitest';
import { ledger, parseDeltaFill, positionDiffs } from './fills-pnl.js';

const raw = (over = {}) => ({ id: 101, product_symbol: 'C-BTC-90000-271126', side: 'sell', size: 5, price: '135', commission: '0.05', role: 'taker', fill_type: 'normal', created_at: '2026-10-28T19:00:08Z', product: { contract_value: '0.001' }, ...over });
const f = (id: string, side: 'buy' | 'sell', qty: number, price: number, fee = 0, symbol = 'C-BTC-90000-271126', contractValue: number | null = 0.001) => ({ exchangeFillId: id, symbol, side, qty, price, fee, contractValue });

describe('parseDeltaFill', () => {
  it('reads the documented fields', () => {
    expect(parseDeltaFill(raw())).toMatchObject({ exchangeFillId: '101', instrument: 'option', side: 'sell', qty: 5, price: 135, fee: 0.05, liquidity: 'taker', contractValue: 0.001, fillType: 'normal' });
  });

  it('accepts a settlement at zero and a perpetual', () => {
    expect(parseDeltaFill(raw({ price: '0', fill_type: 'settlement' }))?.price).toBe(0);
    expect(parseDeltaFill(raw({ product_symbol: 'BTCUSD' }))?.instrument).toBe('perp');
  });

  it('uses the lot on the fill for ETH, and refuses to guess one', () => {
    expect(parseDeltaFill(raw({ product_symbol: 'C-ETH-2400-271126', product: { contract_value: '0.01' } }))?.contractValue).toBe(0.01);
    expect(parseDeltaFill(raw({ product_symbol: 'C-ETH-2400-271126', product: {} }))?.contractValue).toBeNull();
  });

  it('rejects a malformed fill', () => {
    expect(parseDeltaFill(raw({ id: null }))).toBeNull();
    expect(parseDeltaFill(raw({ side: 'x' }))).toBeNull();
    expect(parseDeltaFill(raw({ size: 0 }))).toBeNull();
  });
});

describe('ledger', () => {
  it('matches a hand calculation for a sold leg bought back', () => {
    // sold 5 at 135, bought at 98: 37 x 5 x 0.001 = 0.185, less the two fees
    const { pnl, open } = ledger([f('a', 'sell', 5, 135, 0.05), f('b', 'buy', 5, 98, 0.03)]);
    expect(pnl.get('a')).toBeCloseTo(-0.05);
    expect(pnl.get('b')).toBeCloseTo(0.155);
    expect(open.size).toBe(0);
  });

  it('realises only the part closed', () => {
    const { pnl, open } = ledger([f('a', 'sell', 10, 100), f('b', 'buy', 4, 80)]);
    expect(pnl.get('b')).toBeCloseTo(0.08);
    expect(open.get('C-BTC-90000-271126')).toBe(-6);
  });

  it('averages entries across fills', () => {
    const { pnl } = ledger([f('a', 'sell', 2, 100), f('b', 'sell', 2, 80), f('c', 'buy', 4, 70)]);
    expect(pnl.get('c')).toBeCloseTo(0.08);
  });

  it('handles a fill that closes and flips the position', () => {
    const { pnl, open } = ledger([f('a', 'sell', 2, 100), f('b', 'buy', 5, 90), f('c', 'sell', 3, 95)]);
    expect(pnl.get('b')).toBeCloseTo(0.02);
    expect(pnl.get('c')).toBeCloseTo(0.015);
    expect(open.size).toBe(0);
  });

  it('settles a short that expired worthless', () => {
    expect(ledger([f('a', 'sell', 5, 100), f('b', 'buy', 5, 0)]).pnl.get('b')).toBeCloseTo(0.5);
  });

  it('keeps symbols apart', () => {
    const { open } = ledger([f('a', 'sell', 5, 100), f('b', 'sell', 3, 90, 0, 'P-BTC-70000-271126')]);
    expect(open.size).toBe(2);
  });

  it('leaves a fill unpriced when the lot is unknown', () => {
    expect(ledger([f('a', 'sell', 1, 100, 0, 'C-ETH-1-271126', null)]).pnl.get('a')).toBeNull();
  });
});

describe('positionDiffs', () => {
  it('finds differences both ways', () => {
    expect(positionDiffs(new Map([['A', -5], ['B', -2]]), new Map([['A', -5], ['C', 1]]))).toEqual(['B', 'C']);
    expect(positionDiffs(new Map([['A', -5]]), new Map([['A', -5]]))).toEqual([]);
  });
});
