import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8');

/** Pulls one function out of the page so it can run here. */
function fnSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = html.indexOf('\r\n  }\r\n', start);
  return html.slice(start, end + 5);
}

const parseSym = (s: string) => {
  const m = /^([CP])-BTC-(\d+)-(\d{6})$/.exec(s);
  return m ? { type: m[1], strike: +m[2]!, exp: m[3], rawExp: m[3] } : null;
};
const fill = (sym: string, side: string, price: number, t: string, size = 2, commission = 0.01) => ({ product_symbol: sym, side, price, size, commission, created_at: t, product: { contract_value: '0.001' } });
const roundTrip = [
  fill('C-BTC-90000-011126', 'sell', 100, '2026-10-30T15:00:00Z'), fill('P-BTC-70000-011126', 'sell', 80, '2026-10-30T15:00:00Z'),
  fill('C-BTC-90000-011126', 'buy', 60, '2026-10-30T20:00:00Z'), fill('P-BTC-70000-011126', 'buy', 50, '2026-10-30T20:00:00Z'),
];

function page(S: Record<string, unknown>, stored: Record<string, string> = {}) {
  const src = `${fnSource('groupFillsToTrades')}\n${fnSource('lastClosedTrade')}\nreturn lastClosedTrade;`;
  const localStorage = { getItem: (k: string) => stored[k] ?? null };
  return new Function('S', 'parseSym', 'localStorage', src)(S, parseSym, localStorage) as (mode: string) => any;
}

describe('closed trade card', () => {
  it('shows nothing when an account has no fills', () => {
    expect(page({})('readonly')).toBeNull();
    expect(page({})('readtrade')).toBeNull();
  });

  it("never borrows the other account's fills", () => {
    expect(page({ deltaFillsReadTrade: roundTrip })('readonly')).toBeNull();
    expect(page({ deltaFillsReadOnly: roundTrip })('readtrade')).toBeNull();
    expect(page({}, { v_delta_fills_readtrade: JSON.stringify(roundTrip) })('readonly')).toBeNull();
  });

  it('builds the trade from its own fills, with real lots and premium', () => {
    const t = page({ deltaFillsReadTrade: roundTrip })('readtrade');
    expect(t).toMatchObject({ mode: 'readtrade', Kc: 90000, Kp: 70000, lots: 2, fee: 0.04, grossPnl: 0.14, pnl: 0.1, premium: 0.36 });
  });

  it('has a lot figure below the old floor of 5', () => {
    expect(page({ deltaFillsReadOnly: roundTrip })('readonly').lots).toBe(2);
  });

  it('has no invented trade figures left in the page', () => {
    for (const s of ['oct28-strangle-dex', '100% Genuine', '+18.4% Net ROI', '6h 30m Real Cycle', 'spot: 80999', "|| '83600'", '|| 0.097', '|| 134', 'updateFloatingPnl']) {
      expect(html).not.toContain(s);
    }
  });
});
