import { describe, it, expect } from 'vitest';
import type { LegRow, PulseCohort } from '../snapshot.js';
import { metricSeries, winnerAtAge, type CohortRow } from './series.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

const cohort = (over: Partial<PulseCohort> = {}): PulseCohort => ({
  id: 'c1', slot: 'current', series_id: 's1', slot_ms: T0, expiry_ms: T0 + 1440 * MIN, status: 'open',
  opened_at: T0, closed_at: null, close_reason: null, spot_entry: 100000, fut_entry_bid: 100000, fut_entry_ask: 100000,
  call_symbol: 'C', put_symbol: 'P', call_strike: 105000, put_strike: 95000,
  call_bid: 95, put_bid: 95, call_mid: 100, put_mid: 100, call_delta: 0.2, put_delta: 0.2,
  call_theta: -240, put_theta: -240, call_iv: 50, put_iv: 50, call_gamma: 0, put_gamma: 0, call_vega: 0, put_vega: 0,
  call_oi_band: 10, put_oi_band: 10, fee: { takerRate: 0, makerRate: 0, premiumCapRate: 0, contractValue: 0.001 }, missing: null,
  call_sl_at: null, put_sl_at: null, net_pnl: null, ...over,
});

const leg = (which: 'call' | 'put', minutes: number, over: Partial<LegRow> = {}): LegRow => {
  const mid = over.mid === undefined ? 100 : over.mid;
  return {
    cohort_id: 'c1', grid_ms: T0 + minutes * MIN, sampled_ms: T0 + minutes * MIN, leg: which, minutes_since_entry: minutes,
    strike: which === 'call' ? 105000 : 95000, expiry_ms: T0 + 1440 * MIN,
    bid: mid === null ? null : mid - 1, ask: mid === null ? 101 : mid + 1, mark: mid ?? 100, mid, delta: 0.2, gamma: 0, theta: -240, vega: 0, iv: 50,
    oi: 10, oi_band: 10, oi_change: 0, volume_raw: 1, volume_change: 0, net_pnl: 0, sl_hit: false, data_ok: true, ...over,
  };
};

interface Spec { spot?: number; fut?: number; net?: number | null; call?: Partial<LegRow>; put?: Partial<LegRow>; ok?: boolean; grid?: number }

/** A row sampled `minutes` after entry; `grid` labels it differently when a test needs the two times apart. */
const row = (minutes: number, s: Spec = {}): CohortRow => ({
  grid_ms: T0 + (s.grid ?? minutes) * MIN, sampled_ms: T0 + minutes * MIN, spot: s.spot ?? 100000, fut_price: s.fut ?? 100000,
  net_delta: s.net === undefined ? 0 : s.net, fut_long_pnl: 0, fut_short_pnl: 0, data_ok: s.ok ?? true,
  call: leg('call', minutes, s.call), put: leg('put', minutes, s.put),
});

const SPEED_KEYS = [
  'de_call', 'de_put', 'balance_drift', 'dsi', 'net_delta', 'iv_call_since_entry', 'iv_put_since_entry', 'range_ratio',
  'exit_cost', 'spread_call', 'spread_put', 'move_vs_breakeven', 'efficiency_ratio',
];

describe('metricSeries: two steps worked by hand', () => {
  // Entry: mids 100/100, theta 240/day, IV 50/50, credit 95+95=190, breakevens 105190 and 94810, room 5190, futEntry 100000.
  const row0 = row(15, {
    spot: 100000, fut: 100000, net: 0,
    call: { mid: 98, delta: 0.2, iv: 50, oi_change: 1, volume_change: null, minutes_since_entry: 16 },
    put: { mid: 99, delta: 0.2, iv: 50, oi_change: 1, volume_change: null },
  });
  const row1 = row(360, {
    spot: 101000, fut: 101038, net: 0.03,
    call: { mid: 70, delta: 0.22, iv: 47, oi_change: 5, volume_change: 3, minutes_since_entry: 360 },
    put: { mid: 85, delta: 0.19, iv: 52, oi_change: -2, volume_change: 1 },
  });
  const m = metricSeries(cohort(), [row0, row1]);

  it('one step per good row, carrying its own times', () => {
    expect(m).toHaveLength(2);
    expect(m[0].grid_ms).toBe(row0.grid_ms);
    expect(m[1].sampled_ms).toBe(row1.sampled_ms);
    expect(m[0].minutes_since_entry).toBe(16); // the stored leg value, not recomputed
    expect(m[1].minutes_since_entry).toBe(360);
  });

  it('decay efficiency', () => {
    // 6h = 0.25d, so expected decay = 240 x 0.25 = 60. Call (100-70)/60 = 0.5, put (100-85)/60 = 0.25.
    expect(m[1].de_call).toBeCloseTo(0.5, 6);
    expect(m[1].de_put).toBeCloseTo(0.25, 6);
    // 15m = 1/96d, so expected = 2.5. Call (100-98)/2.5 = 0.8, put (100-99)/2.5 = 0.4.
    expect(m[0].de_call).toBeCloseTo(0.8, 6);
    expect(m[0].de_put).toBeCloseTo(0.4, 6);
  });

  it('balance drift and heavy leg use mids', () => {
    // |ln(70/85) - ln(100/100)| = ln(85/70). Ratios 0.70 and 0.85: gap 0.15 >= 0.1, the put is heavy.
    expect(m[1].balance_drift).toBeCloseTo(Math.log(85 / 70), 6);
    expect(m[1].heavy_leg).toBe('put');
  });

  it('dsi', () => {
    // (|0.22-0.20| + |0.19-0.20|) / (|101000-100000| / 100000 x 100) = 0.03 / 1
    expect(m[1].dsi).toBeCloseTo(0.03, 6);
  });

  it('net delta is the stored signed value', () => {
    expect(m[1].net_delta).toBeCloseTo(0.03, 9);
  });

  it('iv changes', () => {
    expect(m[1].iv_call_since_entry).toBeCloseTo(-3, 9); // 47 - 50
    expect(m[1].iv_put_since_entry).toBeCloseTo(2, 9); // 52 - 50
    expect(m[1].iv_call_1h).toBeNull();
    expect(m[1].iv_put_1h).toBeNull();
  });

  it('expected move and range ratio', () => {
    // 100000 x 50/100 x sqrt(0.25/365); the mean entry IV is 50.
    const em = 50000 * Math.sqrt(0.25 / 365);
    expect(m[1].expected_move).toBeCloseTo(em, 6);
    // spots 100000 (entry), 100000, 101000: range 1000.
    expect(m[1].range_ratio).toBeCloseTo(1000 / em, 6);
  });

  it('oi signal reads premium change against the previous good row, or entry on the first', () => {
    expect(m[0].oi_call).toBe('unconfirmed'); // -2 from entry, OI +1, no volume change stored
    expect(m[1].oi_call).toBe('short_buildup'); // 70-98 falling, OI +5, volume +3
    expect(m[1].oi_put).toBe('long_unwinding'); // 85-99 falling, OI -2, volume +1
  });

  it('spreads, medians, exit cost and liquidity', () => {
    // Each ask-bid is 2. Call spreads 2/98 then 2/70; put 2/99 then 2/85.
    expect(m[1].spread_call).toBeCloseTo(2 / 70, 9);
    expect(m[1].spread_put).toBeCloseTo(2 / 85, 9);
    // One prior row is under spreadMedianMinSamples (6): no median, so only the 10% rule can veto.
    expect(m[1].spread_median_call).toBeNull();
    expect(m[1].spread_median_put).toBeNull();
    expect(m[1].spread_veto).toBe(false);
    expect(m[1].liquidity_unknown).toBe(false);
    // (71-70 + 86-85) / 190
    expect(m[1].exit_cost).toBeCloseTo(2 / 190, 9);
    expect(m[1].liquidity).toBe('normal');
  });

  it('move vs breakeven and efficiency', () => {
    expect(m[1].move_vs_breakeven).toBeCloseTo(0.2, 9); // 1038 / 5190
    // Two good steps are under minPathSteps (4).
    expect(m[1].efficiency_ratio).toBeNull();
  });

  it('speed is the change per 15 minutes of real time', () => {
    // 345 elapsed minutes = 23 steps.
    expect(m[1].speed.de_call).toBeCloseTo((0.5 - 0.8) / 23, 9);
    expect(m[1].speed.net_delta).toBeCloseTo(0.03 / 23, 9);
    expect(m[1].speed.iv_call_since_entry).toBeCloseTo(-3 / 23, 9);
    expect(m[1].speed.dsi).toBeNull(); // the first step has no dsi
    expect(Object.keys(m[1].speed).sort()).toEqual([...SPEED_KEYS].sort());
  });

  it('first step: dsi and speeds are null', () => {
    expect(m[0].dsi).toBeNull();
    expect(Object.keys(m[0].speed).sort()).toEqual([...SPEED_KEYS].sort());
    for (const k of SPEED_KEYS) expect(m[0].speed[k]).toBeNull();
  });
});

describe('metricSeries rules', () => {
  it('returns nothing for no rows or only bad rows', () => {
    expect(metricSeries(cohort(), [])).toEqual([]);
    expect(metricSeries(cohort(), [row(15, { ok: false })])).toEqual([]);
  });

  it('skips a data_ok=false row and compares with the last good row', () => {
    const m = metricSeries(cohort(), [
      row(15, { spot: 100000, fut: 100000, call: { mid: 90, delta: 0.2, oi_change: 1, volume_change: 1 } }),
      row(30, { ok: false, spot: 200000, fut: 200000, call: { mid: 500, delta: 0.9 } }),
      row(45, { spot: 101000, fut: 100000, call: { mid: 95, delta: 0.22, oi_change: 1, volume_change: 1 } }),
    ]);
    expect(m.map((s) => s.grid_ms)).toEqual([T0 + 15 * MIN, T0 + 45 * MIN]);
    expect(m[1].dsi).toBeCloseTo(0.02, 6); // 0.02 / 1%, against the row at 15m
    expect(m[1].oi_call).toBe('long_buildup'); // 95-90 rising; against the bad row it would be falling
    expect(m[1].range_ratio).toBeCloseTo(1000 / m[1].expected_move!, 6); // the 200000 is not in the range
    expect(m[1].move_vs_breakeven).toBeCloseTo(0, 9); // nor the 200000 future
    expect(m[1].efficiency_ratio).toBeNull(); // no path at all
    // Speed spans 30 minutes back to the good row: 2 steps.
    expect(m[1].speed.iv_call_since_entry).toBeCloseTo(0, 9);
    expect(m[1].speed.spread_call).toBeCloseTo((2 / 95 - 2 / 90) / 2, 9);
  });

  it('speed uses real elapsed time across a gap', () => {
    // Grids are 15 minutes apart but the second read was late: +10 over 30 sampled minutes is 2 steps, so speed 5.
    const m = metricSeries(cohort(), [
      row(15, { grid: 15, call: { iv: 50 } }),
      row(45, { grid: 30, call: { iv: 60 } }),
    ]);
    expect(m[1].speed.iv_call_since_entry).toBeCloseTo(5, 9);
  });

  it('speed is null with zero elapsed time', () => {
    const m = metricSeries(cohort(), [row(15, { grid: 15, call: { iv: 50 } }), row(15, { grid: 30, call: { iv: 60 } })]);
    expect(m[1].speed.iv_call_since_entry).toBeNull();
  });

  it('speed is null when the previous good step has no value', () => {
    const m = metricSeries(cohort(), [row(15, { call: { mid: null } }), row(30, { call: { mid: 90 } })]);
    expect(m[0].de_call).toBeNull();
    expect(m[1].de_call).not.toBeNull();
    expect(m[1].speed.de_call).toBeNull();
  });

  it('elapsed time comes from sampled_ms, not grid_ms', () => {
    // Sampled 6h after entry although labelled as the 15m grid: 30 / (240 x 0.25) = 0.5.
    const m = metricSeries(cohort(), [row(360, { grid: 15, call: { mid: 70 } })]);
    expect(m[0].de_call).toBeCloseTo(0.5, 9);
  });

  it('move and path use fut_price; efficiency waits for minPathSteps', () => {
    // Spot never moves. Futures 100000 (entry) -> 101038 -> 100519 -> 100519 -> 100519 -> 100519.
    const m = metricSeries(cohort(), [15, 30, 45, 60, 75].map((t, i) => row(t, { fut: i === 0 ? 101038 : 100519 })));
    expect(m[1].range_ratio).toBe(0);
    expect(m[1].move_vs_breakeven).toBeCloseTo(0.2, 9); // the largest move 1038 / 5190, not the last 519
    expect([m[0], m[1], m[2]].map((s) => s.efficiency_ratio)).toEqual([null, null, null]);
    expect(m[3].efficiency_ratio).toBeCloseTo(519 / 1557, 9); // step 4: net 519, path 1038 + 519
    expect(m[3].speed.efficiency_ratio).toBeNull(); // step 3 had none
    expect(m[4].speed.efficiency_ratio).toBeCloseTo(0, 9);
  });

  it('futEntry is the mean of the entry bid and ask', () => {
    // futEntry 100010, so the move is 1038 - 10 = 1028 and spot_entry still sets the room of 5190.
    const m = metricSeries(cohort({ fut_entry_bid: 100000, fut_entry_ask: 100020 }), [row(15, { fut: 101038 })]);
    expect(m[0].move_vs_breakeven).toBeCloseTo(1028 / 5190, 9);
  });

  it('iv 1h compares with the latest good row at least an hour old', () => {
    const rows = [50, 51, 52, 53, 56].map((iv, i) => row(15 * (i + 1), { call: { iv }, put: { iv: 60 - i } }));
    rows.splice(1, 0, row(15, { ok: false, call: { iv: 99 } })); // bad: never the base
    const m = metricSeries(cohort(), rows);
    expect(m).toHaveLength(5);
    expect(m[3].iv_call_1h).toBeNull(); // at 60m the target is entry time: no row that old
    expect(m[4].iv_call_1h).toBeCloseTo(6, 9); // at 75m, the row at 15m: 56 - 50
    expect(m[4].iv_put_1h).toBeCloseTo(-4, 9); // 56 - 60
  });

  it('iv 1h follows time, not row count, across gaps', () => {
    // Four rows back from 180m is the 15m row, but the newest row at least an hour old is at 60m, 60 minutes short of the target.
    const gap = metricSeries(cohort(), [15, 30, 45, 60, 180].map((t) => row(t, { call: { iv: t === 180 ? 70 : 50 } })));
    expect(gap[4].iv_call_1h).toBeNull();
    // Only one row back, yet exactly an hour old.
    const sparse = metricSeries(cohort(), [row(15, { call: { iv: 50 } }), row(75, { call: { iv: 53 } })]);
    expect(sparse[1].iv_call_1h).toBeCloseTo(3, 9);
    // The base may be one grid older than the target, not more.
    expect(metricSeries(cohort(), [row(15, { call: { iv: 50 } }), row(90, { call: { iv: 52 } })])[1].iv_call_1h).toBeCloseTo(2, 9);
    expect(metricSeries(cohort(), [row(15, { call: { iv: 50 } }), row(91, { call: { iv: 52 } })])[1].iv_call_1h).toBeNull();
  });

  // Mid 100 throughout, so the spread is ask - bid over 100.
  const q = (spread: number) => ({ bid: 100 - spread * 50, ask: 100 + spread * 50, mid: 100 });

  it('the spread median is over prior rows only and needs spreadMedianMinSamples of them', () => {
    // Prior call spreads 0.02 x3 and 0.04 x3: median 0.03. With this row's 0.09 included it would be 0.04.
    const prior = [0.02, 0.02, 0.02, 0.04, 0.04, 0.04].map((s, i) => row(15 * (i + 1), { call: q(s) }));
    const m = metricSeries(cohort(), [...prior, row(105, { call: q(0.09) })]);
    expect(m[5].spread_median_call).toBeNull(); // five prior rows
    expect(m[6].spread_median_call).toBeCloseTo(0.03, 9);
    expect(m[6].spread_veto).toBe(true); // 0.09 > 2 x 0.03, though under 0.1
    expect(m[5].spread_veto).toBe(false); // 0.04 with no median cannot trip the 2x rule
  });

  it('the first rows cannot trigger the 2x rule and a flat series never vetoes', () => {
    // Doubling on the second row would trip a median that included only one row.
    const jump = metricSeries(cohort(), [row(15, { call: q(0.02) }), row(30, { call: q(0.05) })]);
    expect(jump[1].spread_veto).toBe(false);
    const flat = metricSeries(cohort(), Array.from({ length: 10 }, (_, i) => row(15 * (i + 1), { call: q(0.03), put: q(0.03) })));
    expect(flat.every((s) => s.spread_veto === false)).toBe(true);
    expect(flat[9].spread_median_call).toBeCloseTo(0.03, 9);
  });

  it('the spread median window is the 24h before this row by sampled_ms', () => {
    const day = 1440;
    const m = metricSeries(cohort(), [
      row(15, { call: q(0.02) }), // exactly 24h before the row at day+15
      ...[30, 45, 60, 75, 90].map((t) => row(t, { call: q(0.04) })),
      row(day + 15, { call: q(0.04) }),
      row(day + 31, { call: q(0.04) }), // now the 15m and 30m rows are out: 5 prior rows remain
    ]);
    expect(m[6].spread_median_call).toBeCloseTo(0.04, 9); // [0.02, 0.04 x5], the boundary row counted
    expect(m[7].spread_median_call).toBeNull();
  });

  it('spread veto is a Kleene OR of the legs', () => {
    const wide = { bid: 90, ask: 110, mid: 100 };
    expect(metricSeries(cohort(), [row(15, { put: wide })])[0].spread_veto).toBe(true); // 0.2 > 0.1
    expect(metricSeries(cohort(), [row(15, { call: wide })])[0].spread_veto).toBe(true);
    const noBid = metricSeries(cohort(), [row(15, { call: { bid: null } })])[0];
    expect(noBid.spread_call).toBeNull();
    expect(noBid.spread_veto).toBeNull();
    expect(noBid.liquidity_unknown).toBe(true);
    // A known veto is never hidden by a missing quote on the other leg.
    expect(metricSeries(cohort(), [row(15, { call: { bid: null }, put: wide })])[0].spread_veto).toBe(true); // null + true
    expect(metricSeries(cohort(), [row(15, { call: wide, put: wide })])[0].spread_veto).toBe(true); // true + true
    expect(metricSeries(cohort(), [row(15)])[0].spread_veto).toBe(false); // false + false; noBid above is null + false
  });

  it('liquidity is unknown when the exit cost is missing', () => {
    const s = metricSeries(cohort({ put_bid: null }), [row(15)])[0];
    expect(s.spread_veto).toBe(false);
    expect(s.exit_cost).toBeNull();
    expect(s.liquidity_unknown).toBe(true);
  });

  it('liquidity bands the exit cost', () => {
    // (10 + 10) / 190 is above 0.1.
    const wide = { ask: 110, mid: 100, bid: 99 };
    const m = metricSeries(cohort(), [row(15, { call: wide, put: wide })]);
    expect(m[0].exit_cost).toBeCloseTo(20 / 190, 9);
    expect(m[0].liquidity).toBe('veto');
  });

  it('net delta is null when a leg delta is missing', () => {
    const m = metricSeries(cohort(), [row(15, { net: -0.2, call: { delta: null } })]);
    expect(m[0].net_delta).toBeNull();
  });

  it('missing inputs give null, never 0, NaN or Infinity', () => {
    const bare = cohort({
      spot_entry: null, fut_entry_bid: null, fut_entry_ask: null, call_strike: null, put_strike: null, call_bid: null, put_bid: null,
      call_mid: null, put_mid: null, call_theta: null, put_theta: null, call_iv: null, put_iv: null,
    });
    const m = metricSeries(bare, [row(15), row(30, { spot: 101000, fut: 101000 })]);
    const s = m[1];
    for (const v of [s.de_call, s.de_put, s.balance_drift, s.heavy_leg, s.iv_call_since_entry, s.iv_put_since_entry, s.expected_move, s.range_ratio, s.exit_cost, s.liquidity, s.move_vs_breakeven, s.efficiency_ratio]) {
      expect(v).toBeNull();
    }
    const walk = (x: unknown): void => {
      if (typeof x === 'number') expect(Number.isFinite(x)).toBe(true);
      else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    };
    walk(m);
  });

  it('heavy leg names the only leg above entry under the gap', () => {
    // Call +5%, put -3%: gap 0.08 is under heavyLegGap, but only the call is above entry.
    expect(metricSeries(cohort(), [row(15, { call: { mid: 105 }, put: { mid: 97 } })])[0].heavy_leg).toBe('call');
  });

  it('a zero theta gives null decay, not Infinity', () => {
    expect(metricSeries(cohort({ call_theta: 0 }), [row(15)])[0].de_call).toBeNull();
  });
});

describe('winnerAtAge', () => {
  // The hedge P&L in each row picks the side; persistenceAgeMinutes is 60.
  const at = (minutes: number, side: 'long' | 'short' | 'tie', ok = true): CohortRow => ({
    ...row(minutes, { ok }), fut_long_pnl: side === 'long' ? 5 : 1, fut_short_pnl: side === 'short' ? 5 : 1,
  });

  it('judges at the good row nearest the age, not the latest row', () => {
    expect(winnerAtAge(cohort(), [at(45, 'short'), at(60, 'long'), at(75, 'short'), at(600, 'short')])).toEqual({ side: 'long' });
    expect(winnerAtAge(cohort(), [at(50, 'long'), at(80, 'short')])).toEqual({ side: 'long' }); // 10 away beats 20
  });

  it('a young cohort is not judged', () => {
    expect(winnerAtAge(cohort(), [at(15, 'long'), at(30, 'long')])).toBeNull();
    expect(winnerAtAge(cohort(), [])).toBeNull();
  });

  it('needs a good row within one grid of the age', () => {
    expect(winnerAtAge(cohort(), [at(45, 'short'), at(60, 'long', false)])).toEqual({ side: 'short' });
    expect(winnerAtAge(cohort(), [at(30, 'long'), at(100, 'long')])).toBeNull();
  });

  it('a judged tie has no side but still counts', () => {
    expect(winnerAtAge(cohort(), [at(60, 'tie')])).toEqual({ side: null });
  });
});
