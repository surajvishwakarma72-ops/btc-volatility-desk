import { describe, it, expect } from 'vitest';
import type { ChainOption } from '../bot/strike-picker.js';
import { planOpen, legNetPnl, futuresNetPnl, isStopHit, oiBand, delta2, feedFingerprint } from './cohort.js';

const EXP = 1_800_000_000_000;

function opt(type: 'call' | 'put', strike: number, delta: number, extra: Partial<ChainOption> = {}): ChainOption {
  return { symbol: `${type}-${strike}`, type, strike, expiryMs: EXP, delta, bid: 10, ask: 12, mark: 11, iv: 0.5, ...extra };
}

describe('planOpen', () => {
  it('picks the strike closest to 0.125 inside the band', () => {
    const chain = [opt('call', 80000, 0.09), opt('call', 79000, 0.12), opt('call', 78000, 0.14), opt('put', 70000, 0.13)];
    const plan = planOpen(chain, EXP);
    expect(plan.kind).toBe('open');
    if (plan.kind === 'open') {
      expect(plan.call.strike).toBe(79000);
      expect(plan.put.strike).toBe(70000);
    }
  });

  it('counts a zero ask, an unusable iv or a non-operational status as a missing side', () => {
    const put = opt('put', 70000, 0.12);
    for (const bad of [{ ask: 0 }, { iv: Number.NaN }, { iv: 0 }, { tradingStatus: 'disrupted_post_only' }]) {
      expect(planOpen([opt('call', 79000, 0.12, bad), put], EXP)).toEqual({ kind: 'no_valid_strikes', missing: ['call'] });
    }
    expect(planOpen([opt('call', 79000, 0.12, { tradingStatus: 'operational' }), put], EXP).kind).toBe('open');
  });

  it('skips an unusable strike for a usable one', () => {
    const plan = planOpen([opt('call', 79000, 0.125, { ask: 0 }), opt('call', 80000, 0.11), opt('put', 70000, 0.12)], EXP);
    expect(plan.kind === 'open' && plan.call.strike).toBe(80000);
  });

  it('returns no_valid_strikes naming the missing side', () => {
    const chain = [opt('call', 76000, 0.2), opt('put', 70000, 0.12)];
    expect(planOpen(chain, EXP)).toEqual({ kind: 'no_valid_strikes', missing: ['call'] });
  });
});

describe('legNetPnl', () => {
  it('matches a hand calculation', () => {
    const fee = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 };
    // gross 0.05; fees (0.007 entry cap + 0.00525 exit cap) * 1.18 = 0.014455; slippage 0.01 * 0.2 = 0.002
    expect(legNetPnl({ entryBid: 200, ask: 150, spot: 77000, fee })).toBeCloseTo(0.033545, 6);
  });
});

describe('futuresNetPnl', () => {
  it('long: gross minus two fees', () => {
    // gross 1000 * 0.001 = 1; each fee 0.0005*price*0.001*1.18
    const fees = 0.0005 * 77000 * 0.001 * 1.18 + 0.0005 * 78000 * 0.001 * 1.18;
    expect(futuresNetPnl({ side: 'long', entry: 77000, exit: 78000 })).toBeCloseTo(1 - fees, 8);
  });
  it('short profits when price falls', () => {
    const fees = 0.0005 * 77000 * 0.001 * 1.18 + 0.0005 * 76000 * 0.001 * 1.18;
    expect(futuresNetPnl({ side: 'short', entry: 77000, exit: 76000 })).toBeCloseTo(1 - fees, 8);
  });
});

describe('isStopHit', () => {
  it('flags stop exactly at 2x', () => {
    expect(isStopHit(100, 200, 190)).toBe(true);
    expect(isStopHit(100, 199.9, 190)).toBe(false);
  });
  it('ignores a spiked ask more than 1.5x the mark', () => {
    expect(isStopHit(100, 300, 200)).toBe(true);
    expect(isStopHit(100, 300.1, 200)).toBe(false);
  });
  it('needs a valid mark', () => {
    expect(isStopHit(100, 200, 0)).toBe(false);
    expect(isStopHit(100, 200, -5)).toBe(false);
    expect(isStopHit(100, 200, Number.NaN)).toBe(false);
  });
});

describe('oiBand', () => {
  const strikes = [70000, 71000, 72000, 73000, 74000];
  const chain = [
    ...strikes.map((s, i) => opt('call', s, 0.1, { oi: (i + 1) * 10 })),
    ...strikes.map((s) => opt('put', s, 0.1, { oi: 1000 })),
    { ...opt('call', 72000, 0.1, { oi: 5000 }), expiryMs: EXP + 1 },
  ];
  it('sums two listed strikes either side', () => {
    expect(oiBand(chain, 'call', EXP, 72000)).toBe(10 + 20 + 30 + 40 + 50);
  });
  it('stops at the chain edge', () => {
    expect(oiBand(chain, 'call', EXP, 70000)).toBe(10 + 20 + 30);
  });
  it('returns null when the sold strike is not listed', () => {
    expect(oiBand(chain, 'call', EXP, 72500)).toBeNull();
  });
  it('skips strikes lacking oi and returns null if none have it', () => {
    const partial = [opt('call', 71000, 0.1), opt('call', 72000, 0.1, { oi: 7 }), opt('call', 73000, 0.1, { oi: 3 })];
    expect(oiBand(partial, 'call', EXP, 72000)).toBe(10);
    expect(oiBand([opt('call', 72000, 0.1)], 'call', EXP, 72000)).toBeNull();
  });
});

describe('feedFingerprint', () => {
  const perp = { bid: 1, ask: 2 };
  const a = opt('call', 70000, 0.1);
  const b = opt('put', 70000, 0.1);
  it('ignores option order and non-book fields', () => {
    expect(feedFingerprint([a, b], perp)).toBe(feedFingerprint([{ ...b, mark: 99, iv: 9 }, a], perp));
  });
  it('changes with any option or perp bid or ask', () => {
    const fp = feedFingerprint([a, b], perp);
    expect(feedFingerprint([{ ...a, bid: 11 }, b], perp)).not.toBe(fp);
    expect(feedFingerprint([a, { ...b, ask: 13 }], perp)).not.toBe(fp);
    expect(feedFingerprint([a, b], { bid: 1.5, ask: 2 })).not.toBe(fp);
    expect(feedFingerprint([a, b], { bid: 1, ask: 2.5 })).not.toBe(fp);
  });
});

describe('delta2', () => {
  it('returns the change since last snapshot', () => {
    expect(delta2(120, 100)).toBe(20);
    expect(delta2(80, 100)).toBe(-20);
  });
  it('is null when either side is missing', () => {
    expect(delta2(null, 100)).toBeNull();
    expect(delta2(100, null)).toBeNull();
  });
  it('is null for a negative change when nonNegative is set', () => {
    expect(delta2(80, 100, { nonNegative: true })).toBeNull();
    expect(delta2(120, 100, { nonNegative: true })).toBe(20);
  });
});
