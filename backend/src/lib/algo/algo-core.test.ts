import { describe, expect, it } from 'vitest';
import { adxLast, emaLast, evalConditions, type MarketView } from './conditions.js';
import { chooseExpiries, expiryCodeOf, planOptionEntry } from './plan.js';
import { DEFAULT_EXIT, defaultStrangle, entryState, exitAtMs, strategySchema, windowOn } from './rule.js';
import { IST_OFFSET_MS, istMidnightMs } from '../bot/schedule.js';
import type { ChainOption } from '../bot/strike-picker.js';
import type { Bar } from '../bot/futures.js';

const ist = (date: string, hhmm: string) => istMidnightMs(date) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000;
// 2026-10-26 is a Monday
const MON = '2026-10-26', TUE = '2026-10-27', FRI = '2026-10-30';

describe('rule validation', () => {
  it('accepts the default strangle and rejects bad rules', () => {
    expect(strategySchema.safeParse(defaultStrangle()).success).toBe(true);
    expect(strategySchema.safeParse(defaultStrangle({ legs: [] })).success).toBe(false);
    expect(strategySchema.safeParse(defaultStrangle({ expiry: { mode: 'fixed' } })).success).toBe(false);
    expect(strategySchema.safeParse(defaultStrangle({ days: [] })).success).toBe(false);
    expect(strategySchema.safeParse(defaultStrangle({ entry: { kind: 'hard', time: '25:00' } })).success).toBe(false);
    const swapped = defaultStrangle({ legs: [{ type: 'call', side: 'sell', pick: { mode: 'delta', low: 0.2, high: 0.1 } }] });
    expect(strategySchema.safeParse(swapped).success).toBe(false);
    const badEma = defaultStrangle({ entry: { kind: 'window', from: '10:00', to: '11:00', conditions: [{ type: 'ema', tf: '5m', fast: 50, slow: 20, state: 'above' }] } });
    expect(strategySchema.safeParse(badEma).success).toBe(false);
  });
  it('a futures rule needs its side', () => {
    expect(strategySchema.safeParse({ ...defaultStrangle(), instrument: 'future', legs: [] }).success).toBe(false);
    expect(strategySchema.safeParse({ ...defaultStrangle(), instrument: 'future', legs: [], future: { side: 'long' } }).success).toBe(true);
  });
});

describe('entry windows and days', () => {
  const hard = defaultStrangle({ entry: { kind: 'hard', time: '22:30' } });
  it('a hard time is open for one minute', () => {
    expect(entryState(hard, ist(MON, '22:29')).state).toBe('before');
    expect(entryState(hard, ist(MON, '22:30')).state).toBe('open');
    expect(entryState(hard, ist(MON, '22:31')).state).toBe('closed');
  });
  it('a window across midnight stays open after 00:00 and counts as the day it started', () => {
    const win = defaultStrangle({ entry: { kind: 'window', from: '22:30', to: '01:30', conditions: [] }, days: ['fri'] });
    expect(entryState(win, ist(FRI, '23:00')).state).toBe('open');
    const sat = entryState(win, ist('2026-10-31', '01:00'));
    expect(sat.state).toBe('open');
    expect(entryState(win, ist('2026-10-31', '02:00')).state).toBe('closed');
    expect(entryState(win, ist(MON, '23:00')).state).toBe('closed'); // Monday is not selected
    expect(windowOn(win.entry, FRI).endMs - windowOn(win.entry, FRI).startMs).toBe(3 * 3_600_000);
  });
  it('day selection blocks the other days', () => {
    const monOnly = defaultStrangle({ days: ['mon'] });
    expect(entryState(monOnly, ist(TUE, '22:30')).state).toBe('closed');
    expect(entryState(monOnly, ist(MON, '22:30')).state).toBe('open');
  });
  it('the exit time is the first one after the entry', () => {
    const w = windowOn(hard.entry, MON);
    expect(exitAtMs({ ...DEFAULT_EXIT, exitTime: '07:00' }, w, w.startMs)).toBe(ist(TUE, '07:00'));
    expect(exitAtMs({ ...DEFAULT_EXIT, exitTime: '23:30' }, w, w.startMs)).toBe(ist(MON, '23:30'));
    expect(exitAtMs(DEFAULT_EXIT, w, w.startMs)).toBeNull();
    void IST_OFFSET_MS;
  });
});

const bars = (closes: number[], step = 5): Bar[] => closes.map((c, i) => ({ t: i * step * 60_000, o: c, h: c + 5, l: c - 5, c, v: 1 }));
const view = (o: Partial<MarketView> = {}): MarketView => ({ spot: 100_000, dvol: 50, gateGo: true, gateReasons: [], premium: 30, bars5m: [], ...o });

describe('conditions', () => {
  it('compares dvol, spot, premium and gate', () => {
    const r = evalConditions([{ type: 'dvol', op: '<', value: 60 }, { type: 'spot', op: '>', value: 90_000 }, { type: 'premium', value: 25 }, { type: 'gate' }], view());
    expect(r.met).toBe(true);
    expect(evalConditions([{ type: 'dvol', op: '<', value: 40 }], view()).met).toBe(false);
    expect(evalConditions([{ type: 'gate' }], view({ gateGo: false, gateReasons: ['DVOL high'] })).results[0]!.now).toContain('DVOL high');
    expect(evalConditions([{ type: 'premium', value: 25 }], view({ premium: null })).met).toBe(false);
    expect(evalConditions([], view()).met).toBe(true);
  });
  it('a missing indicator never passes', () => {
    expect(evalConditions([{ type: 'rsi', tf: '5m', op: '<', value: 50 }], view()).met).toBe(false);
  });
  it('rsi, ema and adx on built bars', () => {
    const up = bars(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
    expect(evalConditions([{ type: 'rsi', tf: '5m', op: '>', value: 70 }], view({ bars5m: up })).met).toBe(true);
    expect(evalConditions([{ type: 'ema', tf: '5m', fast: 9, slow: 21, state: 'above' }], view({ bars5m: up })).met).toBe(true);
    expect(evalConditions([{ type: 'ema', tf: '5m', fast: 9, slow: 21, state: 'below' }], view({ bars5m: up })).met).toBe(false);
    expect(adxLast(up)!).toBeGreaterThan(25); // a clean trend
    const flat = bars(Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
    expect(adxLast(flat)!).toBeLessThan(adxLast(up)!);
    expect(emaLast([1, 2], 5)).toBeNull();
  });
  it('15m and 1h build from 5m bars', () => {
    const up = bars(Array.from({ length: 200 }, (_, i) => 100 + i));
    expect(evalConditions([{ type: 'rsi', tf: '1h', op: '>', value: 70 }], view({ bars5m: up })).results[0]!.now).toMatch(/RSI/);
  });
});

const opt = (type: 'call' | 'put', strike: number, delta: number, expiryMs: number): ChainOption => ({
  symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${strike}-${expiryCodeOf(expiryMs)}`, type, strike, expiryMs, delta, bid: 50 + strike / 10_000, ask: 55 + strike / 10_000, mark: 52, iv: 0.5,
});
const NOW = ist(MON, '22:30');
const E1 = Date.UTC(2026, 9, 27, 12), E2 = Date.UTC(2026, 9, 28, 12), E3 = Date.UTC(2026, 9, 29, 12);
const chainFor = (e: number): ChainOption[] => [
  opt('call', 104_000, 0.16, e), opt('call', 105_000, 0.13, e), opt('call', 106_000, 0.11, e), opt('call', 107_000, 0.08, e),
  opt('put', 96_000, 0.16, e), opt('put', 95_000, 0.13, e), opt('put', 94_000, 0.105, e), opt('put', 93_000, 0.07, e),
];

describe('planOptionEntry', () => {
  const chain = [...chainFor(E1), ...chainFor(E2)];
  it('picks the lowest delta inside 0.10-0.15 on both sides and trades both back-to-back expiries', () => {
    const p = planOptionEntry(defaultStrangle(), chain, [E1, E2, E3], 100_000, 50, NOW);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.expiries).toEqual(['271026', '281026']);
    expect(p.legs).toHaveLength(4);
    expect(p.legs.every((l) => l.lots === 50 && l.side === 'sell')).toBe(true);
    const e1 = p.legs.filter((l) => l.expiryCode === '271026');
    expect(e1.find((l) => l.type === 'call')!.delta).toBe(0.11);
    expect(e1.find((l) => l.type === 'put')!.delta).toBe(0.105);
    expect(p.premium).toBeGreaterThan(0);
  });
  it('nearest, next and fixed expiry', () => {
    expect(chooseExpiries({ mode: 'nearest' }, [E1, E2], NOW)).toEqual([E1]);
    expect(chooseExpiries({ mode: 'next' }, [E1, E2], NOW)).toEqual([E2]);
    expect(chooseExpiries({ mode: 'fixed', code: '281026' }, [E1, E2], NOW)).toEqual([E2]);
    expect(typeof chooseExpiries({ mode: 'fixed', code: '011126' }, [E1, E2], NOW)).toBe('string');
    expect(chooseExpiries({ mode: 'nearest' }, [E1, E2], E1 - 10 * 60_000)).toEqual([E2]); // too close to settle
  });
  it('says why when no strike fits', () => {
    const p = planOptionEntry(defaultStrangle({ expiry: { mode: 'nearest' } }), [opt('call', 110_000, 0.02, E1), opt('put', 90_000, 0.02, E1)], [E1], 100_000, 10, NOW);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/delta/);
  });
  it('an atm straddle lands on one strike', () => {
    const s = defaultStrangle({ expiry: { mode: 'nearest' }, legs: [{ type: 'call', side: 'sell', pick: { mode: 'atm' } }, { type: 'put', side: 'sell', pick: { mode: 'atm' } }] });
    const c = [opt('call', 100_000, 0.5, E1), opt('put', 100_000, 0.5, E1), opt('call', 101_000, 0.45, E1)];
    const p = planOptionEntry(s, c, [E1], 100_200, 5, NOW);
    expect(p.ok && new Set(p.legs.map((l) => l.strike)).size).toBe(1);
  });
  it('strike and offset picks', () => {
    const s = defaultStrangle({ expiry: { mode: 'nearest' }, legs: [{ type: 'call', side: 'sell', pick: { mode: 'strike', strike: 106_200 } }, { type: 'put', side: 'sell', pick: { mode: 'offset', points: 5_000 } }] });
    const p = planOptionEntry(s, chainFor(E1), [E1], 100_000, 5, NOW);
    expect(p.ok && p.legs.map((l) => l.strike)).toEqual([106_000, 95_000]);
  });
});
