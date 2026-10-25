import { describe, expect, it } from 'vitest';
import {
  aggregate, atr, detectSessionSweep, detectSignal, futuresPnl, planTrade, rangeOf, rsi, stepFutures, sweepConfirmations, vwap,
  type Bar, type FuturesSignal, type FuturesState,
} from './futures.js';
import { istDay, sessionAt, sessionBounds, ukDstAt, usDstAt } from './sessions.js';

const MIN = 60_000;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 100): Bar => ({ t, o, h, l, c, v });

describe('sessions (port of the desk calendar)', () => {
  it('detects UK and US daylight saving on their own dates', () => {
    expect(ukDstAt(Date.parse('2026-07-01T00:00:00Z'))).toBe(true);
    expect(ukDstAt(Date.parse('2026-12-01T00:00:00Z'))).toBe(false);
    // US DST began 2026-03-08 but the UK only on 2026-03-29: the weeks between differ
    expect(usDstAt(Date.parse('2026-03-15T12:00:00Z'))).toBe(true);
    expect(ukDstAt(Date.parse('2026-03-15T12:00:00Z'))).toBe(false);
  });

  it('London opens 13:30 IST in winter and 12:30 IST in summer; New York 20:00 / 19:00', () => {
    const winter = istDay(Date.parse('2026-12-02T06:00:00Z'));
    const summer = istDay(Date.parse('2026-07-02T06:00:00Z'));
    const ist = (ms: number, day: number) => (ms - (day * 86_400_000 - 19_800_000)) / 3_600_000;
    expect(ist(sessionBounds('LONDON', winter).start, winter)).toBe(13.5);
    expect(ist(sessionBounds('LONDON', summer).start, summer)).toBe(12.5);
    expect(ist(sessionBounds('NEW YORK', winter).start, winter)).toBe(20);
    expect(ist(sessionBounds('NEW YORK', summer).start, summer)).toBe(19);
    expect(ist(sessionBounds('ASIA', winter).start, winter)).toBe(5.5);
  });

  it('classifies a moment, including New York after IST midnight', () => {
    expect(sessionAt(Date.parse('2026-12-02T03:00:00Z'))).toBe('ASIA'); // 08:30 IST
    expect(sessionAt(Date.parse('2026-12-02T09:00:00Z'))).toBe('LONDON'); // 14:30 IST
    expect(sessionAt(Date.parse('2026-12-02T16:30:00Z'))).toBe('NEW YORK'); // 22:00 IST
    expect(sessionAt(Date.parse('2026-12-02T20:00:00Z'))).toBe('NEW YORK'); // 01:30 IST next day
    expect(sessionAt(Date.parse('2026-12-02T22:00:00Z'))).toBe('OFF'); // 03:30 IST
  });
});

describe('indicators', () => {
  it('aggregates 1m bars into aligned 5m bars', () => {
    const bars = [bar(0, 10, 12, 9, 11, 1), bar(MIN, 11, 15, 10, 14, 2), bar(5 * MIN, 14, 16, 13, 15, 3)];
    const a = aggregate(bars, 5);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ t: 0, o: 10, h: 15, l: 9, c: 14, v: 3 });
  });

  it('RSI is 100 on a straight rise, near 0 on a straight fall, null with too little data', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 + i))).toBe(100);
    expect(rsi(Array.from({ length: 30 }, (_, i) => 200 - i))!).toBeLessThan(1);
    expect(rsi([1, 2, 3])).toBeNull();
  });

  it('ATR of constant 10-wide bars is 10; VWAP weights by volume', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i * MIN, 100, 105, 95, 100));
    expect(atr(bars)).toBeCloseTo(10, 6);
    expect(vwap([bar(0, 0, 10, 10, 10, 1), bar(1, 0, 20, 20, 20, 3)])).toBeCloseTo(17.5, 6);
  });

  it('range of a window', () => {
    const r = rangeOf([bar(0, 1, 5, 1, 2), bar(10, 1, 9, 0, 2), bar(20, 1, 99, 1, 2)], 0, 15)!;
    expect(r).toMatchObject({ high: 9, low: 0 });
    expect(rangeOf([], 0, 1)).toBeNull();
  });
});

describe('sweep confirmations', () => {
  it('scores a long upper-wick high-volume reclaim above VWAP', () => {
    const prior = Array.from({ length: 30 }, (_, i) => bar(i * 5 * MIN, 100, 101, 99, 100, 100));
    const sweep = bar(31 * 5 * MIN, 100, 110, 99.5, 100.5, 400);
    const closes = [...prior.map((b) => b.c), ...Array.from({ length: 10 }, (_, i) => 100 + i * 2), sweep.c];
    const c = sweepConfirmations(sweep, prior, [bar(0, 90, 91, 89, 90, 2000), sweep], 'short', closes);
    expect(c.find((x) => x.name === 'wick')!.ok).toBe(true);
    expect(c.find((x) => x.name === 'volume')!.ok).toBe(true);
    expect(c.find((x) => x.name === 'vwap')!.ok).toBe(true);
    expect(c).toHaveLength(4);
  });
});

/** Build 1m bars: quiet Asia range around 80,000 (high 80,100 / low 79,900), then a London sweep. */
function asiaThenLondon(opts: { sweepHighVolume: boolean; sweepWick: boolean }) {
  // 2026-12-02 (winter): Asia 05:30-13:30 IST = 00:00-08:00 UTC; London from 08:00 UTC.
  const start = Date.parse('2026-12-01T20:00:00Z');
  const londonOpen = Date.parse('2026-12-02T08:00:00Z');
  const bars: Bar[] = [];
  let p = 80_000;
  for (let t = start; t < londonOpen + 40 * MIN; t += MIN) {
    const wobble = Math.sin(t / 900_000) * 60; // stays within 79,940-80,060, high 80,100 / low 79,900 bound below
    p = 80_000 + wobble;
    bars.push(bar(t, p, Math.min(p + 15, 80_100), Math.max(p - 15, 79_900), p + 2, 100));
  }
  // minutes 08:00-08:25 UTC: drift up then the sweep bar (5m) 08:25-08:30
  const t0 = londonOpen + 25 * MIN;
  const idx = bars.findIndex((b) => b.t === t0);
  for (let k = 0; k < 5; k++) {
    const b = bars[idx + k]!;
    b.o = 80_090; b.h = k === 2 ? (opts.sweepWick ? 80_260 : 80_130) : 80_105; b.l = 80_070; b.c = k === 4 ? 80_040 : 80_095;
    b.v = opts.sweepHighVolume ? 400 : 100;
  }
  bars.length = idx + 5; // cut at the close of the sweep bar
  return { bars, nowMs: t0 + 5 * MIN };
}

describe('detectSessionSweep', () => {
  it('fires a SHORT when London sweeps the Asia high and reclaims with confirmation', () => {
    const { bars, nowMs } = asiaThenLondon({ sweepHighVolume: true, sweepWick: true });
    const s = detectSessionSweep('FUT_SWEEP_LDN', { bars1m: bars, nowMs })!;
    expect(s).not.toBeNull();
    expect(s.dir).toBe('short');
    expect(s.extreme).toBe(80_260);
    expect(s.score).toBeGreaterThanOrEqual(2);
    expect(s.note).toMatch(/swept ASIA high/);
  });

  it('a sweep without enough confirmation does nothing', () => {
    const { bars, nowMs } = asiaThenLondon({ sweepHighVolume: false, sweepWick: false });
    expect(detectSessionSweep('FUT_SWEEP_LDN', { bars1m: bars, nowMs, cfg: { minConfirm: 4 } })).toBeNull();
  });

  it('never fires outside the sweep window or before London opens', () => {
    const { bars } = asiaThenLondon({ sweepHighVolume: true, sweepWick: true });
    expect(detectSessionSweep('FUT_SWEEP_LDN', { bars1m: bars, nowMs: Date.parse('2026-12-02T07:00:00Z') })).toBeNull();
    expect(detectSessionSweep('FUT_SWEEP_LDN', { bars1m: bars, nowMs: Date.parse('2026-12-02T20:00:00Z') })).toBeNull();
    expect(detectSessionSweep('FUT_SWEEP_NY', { bars1m: bars, nowMs: Date.parse('2026-12-02T08:30:00Z') })).toBeNull();
  });

  it('needs enough history', () => {
    expect(detectSessionSweep('FUT_SWEEP_LDN', { bars1m: [], nowMs: Date.parse('2026-12-02T08:30:00Z') })).toBeNull();
  });
});

describe('detectSignal', () => {
  it('requires agreeing votes and rejects conflicting ones', () => {
    const { bars, nowMs } = asiaThenLondon({ sweepHighVolume: true, sweepWick: true });
    // prior-day high just under the sweep: reclaim vote (short) only -> one vote, below minVotes 2
    const one = detectSignal({ bars1m: bars, nowMs, prevDay: { high: 80_100, low: 79_000, from: 0, to: 1 } });
    expect(one).toBeNull();
    const two = detectSignal({ bars1m: bars, nowMs, prevDay: { high: 80_100, low: 79_000, from: 0, to: 1 }, cfg: { minVotes: 1 } });
    expect(two?.dir).toBe('short');
    expect(two?.strategy).toBe('FUT_SIGNAL');
  });
});

const sig = (over: Partial<FuturesSignal> = {}): FuturesSignal => ({
  strategy: 'FUT_SWEEP_LDN', dir: 'short', at: 0, entry: 80_000, extreme: 80_150, atr15: 200, confirmations: [], score: 3, note: '', ...over,
});

describe('planTrade', () => {
  it('sizes by stop distance: a 5 USD risk buys 25 lots at a ~200 USD stop, fewer at a wider stop', () => {
    const tight = planTrade(sig({ extreme: 80_190, atr15: 200 }), { stopBufferAtr: 0 });
    expect(tight.ok && tight.plan.lots).toBe(25);
    const wide = planTrade(sig({ extreme: 80_400, atr15: 200 }));
    expect(wide.ok).toBe(true);
    if (tight.ok && wide.ok) {
      expect(wide.plan.lots).toBeLessThan(tight.plan.lots);
      expect(wide.plan.riskAtStopUsd).toBeLessThanOrEqual(5);
    }
  });

  it('puts the stop beyond the sweep extreme and the target at 2R on the right side', () => {
    const p = planTrade(sig({ dir: 'short', extreme: 80_300, atr15: 150 }), { stopBufferAtr: 0 });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.plan.stop).toBeGreaterThan(80_300 - 1);
      expect(p.plan.target).toBeLessThan(p.plan.entry);
      expect(p.plan.entry - p.plan.target).toBeCloseTo(2 * p.plan.riskDist, 6);
    }
    const l = planTrade(sig({ dir: 'long', extreme: 79_700, atr15: 150 }), { stopBufferAtr: 0 });
    if (l.ok) {
      expect(l.plan.stop).toBeLessThan(79_700 + 1);
      expect(l.plan.target).toBeGreaterThan(l.plan.entry);
    }
  });

  it('rejects a stop so tight that the 25-lot cap leaves fees above the fee-to-risk limit', () => {
    // 120 USD stop at the 25-lot cap risks only 3 USD while the round trip costs about 2.4 USD in fees
    const r = planTrade(sig({ extreme: 80_100, atr15: 200 }), { stopBufferAtr: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fee/);
  });

  it('skips a stop that is too wide, a risk too small for one lot, and a fee-dominated trade', () => {
    const wide = planTrade(sig({ extreme: 82_000 }));
    expect(wide.ok).toBe(false);
    const tiny = planTrade(sig({ extreme: 80_300 }), { riskUsd: 0.05 });
    expect(tiny.ok).toBe(false);
    const fee = planTrade(sig({ extreme: 80_190 }), { stopBufferAtr: 0, maxFeeToRisk: 0.1 });
    expect(fee.ok).toBe(false);
    if (!fee.ok) expect(fee.reason).toMatch(/fee/);
  });

  it('the leverage guard keeps the stop inside the liquidation distance', () => {
    const p = planTrade(sig({ extreme: 80_300 }), { maxLeverage: 200 });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.plan.riskDist).toBeLessThanOrEqual(0.4 * (p.plan.entry / p.plan.leverage) + 1e-9);
  });
});

const state = (over: Partial<FuturesState> = {}): FuturesState => ({
  dir: 'long', entry: 80_000, stop: 79_800, target: 80_400, riskDist: 200, lots: 25, openedAt: 0, best: 80_000, breakevenDone: false, ...over,
});

describe('stepFutures', () => {
  it('stops out on the stop and wins a same-bar tie against the target', () => {
    const st = state();
    expect(stepFutures(st, bar(0, 80_000, 80_100, 79_790, 79_900))).toMatchObject({ exit: true, reason: 'stop' });
    const both = stepFutures(state(), bar(0, 80_000, 80_500, 79_700, 80_000));
    expect(both).toMatchObject({ exit: true, reason: 'stop' });
  });

  it('takes the target as a maker fill at the target price', () => {
    const r = stepFutures(state(), bar(0, 80_000, 80_410, 79_950, 80_300));
    expect(r).toEqual({ exit: true, price: 80_400, reason: 'target', maker: true });
  });

  it('moves to breakeven at 1R, then a later pullback exits at breakeven', () => {
    const st = state();
    expect(stepFutures(st, bar(0, 80_000, 80_210, 79_950, 80_150)).exit).toBe(false);
    expect(st.stop).toBe(80_000);
    expect(st.breakevenDone).toBe(true);
    const r = stepFutures(st, bar(60_000, 80_100, 80_150, 79_990, 80_020));
    expect(r).toMatchObject({ exit: true, reason: 'breakeven' });
  });

  it('trails 1R behind the best price after 1.5R and exits as a trail', () => {
    const st = state();
    stepFutures(st, bar(0, 80_000, 80_320, 79_990, 80_300)); // 1.6R: breakeven then trail to 80_120
    expect(st.stop).toBeCloseTo(80_120, 6);
    const r = stepFutures(st, bar(60_000, 80_300, 80_310, 80_100, 80_110));
    expect(r).toMatchObject({ exit: true, reason: 'trail' });
  });

  it('shorts mirror the longs', () => {
    const st = state({ dir: 'short', entry: 80_000, stop: 80_200, target: 79_600, best: 80_000 });
    expect(stepFutures(st, bar(0, 80_000, 80_050, 79_790, 79_850)).exit).toBe(false);
    expect(st.stop).toBe(80_000);
    expect(stepFutures(st, bar(60_000, 79_900, 80_010, 79_900, 79_950))).toMatchObject({ exit: true, reason: 'breakeven' });
  });

  it('closes at the 12 hour limit', () => {
    const st = state();
    const r = stepFutures(st, bar(12 * 60 * MIN - MIN, 80_000, 80_050, 79_950, 80_020));
    expect(r).toMatchObject({ exit: true, reason: 'time', price: 80_020 });
  });
});

describe('futuresPnl', () => {
  it('signs long and short PnL and nets fees', () => {
    expect(futuresPnl('long', 80_000, 80_400, 25, 1, 1).gross).toBeCloseTo(10, 6);
    expect(futuresPnl('short', 80_000, 80_200, 25, 1, 1).gross).toBeCloseTo(-5, 6);
    expect(futuresPnl('long', 80_000, 80_400, 25, 1.2, 0.8).net).toBeCloseTo(8, 6);
  });
});
