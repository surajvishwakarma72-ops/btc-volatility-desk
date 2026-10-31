import { describe, expect, it } from 'vitest';
import type { ChainOption } from '../bot/strike-picker.js';
import type { FeeRates, PerpQuote } from '../../services/bot/delta-public.js';
import { legNetPnl, futuresNetPnl } from './cohort.js';
import { buildSnapshot, closeNetPnl, type PulseCohort, type LegRow } from './snapshot.js';

const EXP = Date.parse('2026-10-31T12:00:00Z');
const SLOT = Date.parse('2026-10-31T08:00:00Z');
const GRID = SLOT + 30 * 60_000;
const FEE: FeeRates = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 };

const cohort: PulseCohort = {
  id: 'c1', slot: 'current', series_id: 's1', slot_ms: SLOT, expiry_ms: EXP, status: 'open',
  opened_at: SLOT, closed_at: null, close_reason: null, spot_entry: 80000, fut_entry_bid: 79990, fut_entry_ask: 80010,
  call_symbol: 'C-1', put_symbol: 'P-1', call_strike: 82000, put_strike: 78000,
  call_bid: 100, put_bid: 90, call_mid: 101, put_mid: 91, call_delta: 0.12, put_delta: 0.13,
  call_theta: -5, put_theta: -4, call_iv: 40, put_iv: 41, fee: FEE, missing: null,
  call_sl_at: null, put_sl_at: null, net_pnl: null,
};
const perp: PerpQuote = { bid: 80100, ask: 80120, mark: 80110, spot: 80105, tsMs: GRID };

function opt(o: Partial<ChainOption> & Pick<ChainOption, 'symbol' | 'type' | 'strike'>): ChainOption {
  return { expiryMs: EXP, delta: 0.12, bid: 50, ask: 60, mark: 55, iv: 40, ...o };
}
const call = opt({ symbol: 'C-1', type: 'call', strike: 82000, delta: 0.1, bid: 70, ask: 80, mark: 75, oi: 10, volume: 5 });
const put = opt({ symbol: 'P-1', type: 'put', strike: 78000, delta: 0.15, bid: 60, ask: 65, mark: 62, oi: 20, volume: 8 });

describe('buildSnapshot', () => {
  it('stores a missing leg as data_ok=false with null pnl and no stop', () => {
    const s = buildSnapshot(cohort, [call], perp, {}, GRID, GRID);
    expect(s.legs.put).toMatchObject({ data_ok: false, net_pnl: null, sl_hit: false });
    expect(s.legs.call.data_ok).toBe(true);
    expect(s.cohort.data_ok).toBe(false);
    expect(s.cohort.combined_pnl).toBeNull();
    expect(s.cohort.pnl_pct).toBeNull();
    expect(s.cohort.net_delta).toBeNull();
  });

  it('treats ask=0 as missing, never as a free buyback', () => {
    const s = buildSnapshot(cohort, [call, { ...put, ask: 0 }], perp, {}, GRID, GRID);
    expect(s.legs.put).toMatchObject({ data_ok: false, net_pnl: null, sl_hit: false });
    expect(s.cohort.data_ok).toBe(false);
  });

  it('a zero bid alone does not fail a leg', () => {
    const s = buildSnapshot(cohort, [call, { ...put, bid: 0 }], perp, {}, GRID, GRID);
    expect(s.legs.put.data_ok).toBe(true);
    expect(s.cohort.data_ok).toBe(true);
  });

  it('keeps sl_hit once set even after ask falls', () => {
    const c = { ...cohort, put_sl_at: GRID - 900_000 };
    const s = buildSnapshot(c, [call, put], perp, {}, GRID, GRID); // put ask 65 < 2 x 90
    expect(s.legs.put.sl_hit).toBe(true);
    expect(s.legs.call.sl_hit).toBe(false);
  });

  it('flags a fresh stop when ask reaches 2x entry bid', () => {
    const s = buildSnapshot(cohort, [call, { ...put, ask: 180 }], perp, {}, GRID, GRID);
    expect(s.legs.put.sl_hit).toBe(true);
  });

  it('pnl_pct is combined P&L over premium collected', () => {
    const s = buildSnapshot(cohort, [call, put], perp, {}, GRID, GRID);
    const cPnl = legNetPnl({ entryBid: 100, ask: 80, spot: perp.spot, fee: FEE });
    const pPnl = legNetPnl({ entryBid: 90, ask: 65, spot: perp.spot, fee: FEE });
    expect(s.legs.call.net_pnl).toBeCloseTo(cPnl, 10);
    expect(s.cohort.combined_pnl).toBeCloseTo(cPnl + pPnl, 10);
    const collected = (100 + 90) * 1 * 0.001;
    expect(s.cohort.pnl_pct).toBeCloseTo(((cPnl + pPnl) / collected) * 100, 8);
  });

  it('computes premium, net delta, futures and timing fields', () => {
    const s = buildSnapshot(cohort, [call, put], perp, {}, GRID, GRID);
    expect(s.cohort.combined_premium).toBe(145);
    expect(s.cohort.net_delta).toBeCloseTo(0.1 - 0.15, 12);
    expect(s.cohort.fut_price).toBe(80110);
    expect(s.cohort.fut_long_pnl).toBeCloseTo(futuresNetPnl({ side: 'long', entry: 80010, exit: 80100 }), 10);
    expect(s.cohort.fut_short_pnl).toBeCloseTo(futuresNetPnl({ side: 'short', entry: 79990, exit: 80120 }), 10);
    expect(s.legs.call.minutes_since_entry).toBe(30);
    expect(s.legs.call.mid).toBe(75);
    expect(s.legs.call).toMatchObject({ cohort_id: 'c1', grid_ms: GRID, leg: 'call', oi: 10, volume_raw: 5 });
  });

  it('computes oi and volume changes against the previous snapshot', () => {
    const prev = { oi_band: 25, volume_raw: 3 } as LegRow;
    const s = buildSnapshot(cohort, [call, put], perp, { call: prev }, GRID, GRID);
    expect(s.legs.call.oi_band).toBe(10);
    expect(s.legs.call.oi_change).toBe(10 - 25);
    expect(s.legs.call.volume_change).toBe(2);
    expect(s.legs.put.oi_change).toBeNull();
    const rolled = buildSnapshot(cohort, [call, put], perp, { call: { oi_band: 1, volume_raw: 9 } as LegRow }, GRID, GRID);
    expect(rolled.legs.call.volume_change).toBeNull();
  });
});

describe('closeNetPnl', () => {
  const leg = (net: number | null) => ({ net_pnl: net }) as LegRow;
  const net = (entryBid: number, ask: number, spot: number) => legNetPnl({ entryBid, ask, spot, fee: FEE });

  it('EXPIRED uses intrinsic against spot: call in the money, put worthless', () => {
    const got = closeNetPnl(cohort, 'EXPIRED', [], 82500, {});
    expect(got).toBeCloseTo(net(100, 500, 82500) + net(90, 0, 82500), 10);
  });

  it('EXPIRED uses intrinsic against spot: put in the money, call worthless', () => {
    const got = closeNetPnl(cohort, 'EXPIRED', [call, put], 77000, {});
    expect(got).toBeCloseTo(net(100, 0, 77000) + net(90, 1000, 77000), 10);
  });

  it('EXPIRED ignores any chain quote and stored P&L', () => {
    const got = closeNetPnl(cohort, 'EXPIRED', [{ ...call, ask: 9999 }], 80000, { call: leg(5), put: leg(5) });
    expect(got).toBeCloseTo(net(100, 0, 80000) + net(90, 0, 80000), 10);
  });

  it('ROLL uses the current ask of each leg', () => {
    expect(closeNetPnl(cohort, 'ROLL', [call, put], 80105, {})).toBeCloseTo(net(100, 80, 80105) + net(90, 65, 80105), 10);
  });

  it('ROLL falls back to the stored leg P&L when the symbol is gone or its ask is 0', () => {
    expect(closeNetPnl(cohort, 'ROLL', [put], 80105, { call: leg(0.25) })).toBeCloseTo(0.25 + net(90, 65, 80105), 10);
    expect(closeNetPnl(cohort, 'ROLL', [call, { ...put, ask: 0 }], 80105, { put: leg(-0.5) })).toBeCloseTo(net(100, 80, 80105) - 0.5, 10);
  });

  it('ROLL is null when a leg has neither a quote nor a stored P&L', () => {
    expect(closeNetPnl(cohort, 'ROLL', [call], 80105, {})).toBeNull();
    expect(closeNetPnl(cohort, 'ROLL', [call], 80105, { put: leg(null) })).toBeNull();
    expect(closeNetPnl(cohort, 'ROLL', [], 80105, { put: leg(0.1) })).toBeNull();
  });
});
