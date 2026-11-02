import { describe, expect, it } from 'vitest';
import { DEFAULT_RULEBOOK_CONFIG as CFG } from './config.js';
import { evaluateChecklist, sizeTrade, topTierReleases, type ChecklistInput } from './checklist.js';

const NOW = Date.parse('2026-11-02T17:30:00Z'); // 23:00 IST

function good(over: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    nowMs: NOW, marketOk: true, regimeFresh: true, newsFeedDown: false,
    news: { level: null, until: null }, releases: [],
    ivRv: 1.6, adx: 11, killer: false, pulseZone: 'sell',
    legs: [
      { type: 'call', strike: 84000, delta: 0.12, bid: 160, ask: 170 },
      { type: 'put', strike: 72000, delta: -0.11, bid: 150, ask: 160 },
    ],
    equityUsd: 10_000, halfSizeLeft: 0, day: { ruleExits: 0, netPnlUsd: 0, unlocked: false }, smallRiskDay: false,
    ...over,
  };
}

const red = (i: ChecklistInput) => evaluateChecklist(i).red.map((x) => x.id);

describe('before-entry checklist', () => {
  it('all green → GO, with lots and exit levels', () => {
    const r = evaluateChecklist(good());
    expect(r.verdict).toBe('GO');
    expect(r.red).toEqual([]);
    expect(r.sizing.lots).toBeGreaterThan(0);
    expect(r.exitLevels).toEqual({ call: 84000, put: 72000 });
  });

  it('missing data is red, never green', () => {
    expect(red(good({ ivRv: null, adx: null, killer: null, pulseZone: null, releases: null }))).toEqual(['release', 'ivrv', 'adx', 'killer', 'pulse']);
    expect(red(good({ marketOk: false }))).toEqual(['data']);
    expect(red(good({ legs: null }))).toEqual(['delta', 'spread', 'size']);
    const noStrike = evaluateChecklist(good({ legs: null, legsReason: '051126: the closest call to delta 0.1 has delta 0.17, too far away' }));
    expect(noStrike.items.find((x) => x.id === 'delta')).toMatchObject({ ok: false, now: expect.stringContaining('0.17') });
  });

  it('each gate turns red on its own rule', () => {
    expect(red(good({ ivRv: 1.2 }))).toEqual(['ivrv']);
    expect(red(good({ adx: 18 }))).toEqual(['adx']);
    expect(red(good({ killer: true }))).toEqual(['killer']);
    expect(red(good({ pulseZone: 'caution' }))).toEqual(['pulse']);
    expect(red(good({ news: { level: 'CRITICAL', until: NOW + 3_600_000 } }))).toEqual(['news']);
    expect(red(good({ news: { level: 'CRITICAL', until: NOW - 1 } }))).toEqual([]);
  });

  it('a top-tier release 60 min before or 45 min after is red', () => {
    expect(red(good({ releases: [{ title: 'CPI m/m', atMs: NOW + 50 * 60_000 }] }))).toEqual(['release']);
    expect(red(good({ releases: [{ title: 'CPI m/m', atMs: NOW - 30 * 60_000 }] }))).toEqual(['release']);
    expect(red(good({ releases: [{ title: 'CPI m/m', atMs: NOW + 2 * 3_600_000 }] }))).toEqual([]);
  });

  it('strikes outside 0.10–0.15 delta are red', () => {
    const legs = good().legs!.map((l) => (l.type === 'call' ? { ...l, delta: 0.2 } : l));
    expect(red(good({ legs }))).toEqual(['delta']);
  });

  it('a spread over 10% of the premium is red', () => {
    const legs = good().legs!.map((l) => (l.type === 'put' ? { ...l, bid: 100, ask: 125 } : l));
    expect(red(good({ legs }))).toEqual(['spread']);
  });

  it('daily stop after 2 rule exits or a 3% loss, unless unlocked', () => {
    expect(red(good({ day: { ruleExits: 2, netPnlUsd: 0, unlocked: false } }))).toEqual(['daily_stop']);
    expect(red(good({ day: { ruleExits: 0, netPnlUsd: -300, unlocked: false } }))).toEqual(['daily_stop']);
    expect(red(good({ day: { ruleExits: 2, netPnlUsd: -300, unlocked: true } }))).toEqual([]);
  });

  it('no equity set → size is red with a clear note', () => {
    const r = evaluateChecklist(good({ equityUsd: null }));
    expect(r.red.map((x) => x.id)).toEqual(['size']);
    expect(r.red[0]!.now).toContain('set your equity');
  });
});

describe('sizeTrade', () => {
  it('lots = equity × risk ÷ loss per lot at the 1:1 exit, rounded down', () => {
    const s = sizeTrade(good());
    const loss = (160 + 150) * CFG.contractBtc * (1 + CFG.slippagePct / 100) + CFG.feePerLotUsd * 4;
    expect(s.lossPerLotUsd).toBeCloseTo(loss, 6);
    expect(s.lots).toBe(Math.floor(10_000 * CFG.riskPct / 100 / loss));
  });
  it('halves after a rule break and on small-risk days', () => {
    expect(sizeTrade(good({ halfSizeLeft: 3 })).riskPct).toBe(CFG.riskPct / 2);
    expect(sizeTrade(good({ smallRiskDay: true })).riskPct).toBe(CFG.riskPctSmall);
    expect(sizeTrade(good({ smallRiskDay: true, halfSizeLeft: 1 })).riskPct).toBe(CFG.riskPctSmall / 2);
  });
});

describe('calendar in the checklist', () => {
  it('the calendar multiplier scales the risk and replaces the small-risk band', () => {
    const s = sizeTrade(good({ calendarMult: 0.5, smallRiskDay: true }));
    expect(s.riskPct).toBe(CFG.riskPct * 0.5);
  });
  it('a calendar product under 0.25 is red', () => {
    expect(red(good({ calendarMult: 0.19 }))).toEqual(['calendar']);
    expect(red(good({ calendarMult: 0.28 }))).toEqual([]);
  });
  it('a top-tier event before expiry is red; unknown calendar is red', () => {
    expect(red(good({ inPath: [{ label: 'NFP', atMs: NOW + 40 * 3_600_000 }] }))).toEqual(['path']);
    expect(red(good({ inPath: [] }))).toEqual([]);
    expect(red(good({ inPath: null }))).toEqual(['path']);
  });
});

describe('volatility rows in the checklist', () => {
  it('a red volatility row blocks, and its size effect halves the risk', () => {
    const r = evaluateChecklist(good({ volChecks: [{ id: 'compression', label: 'Not in a squeeze', ok: false, now: 'Squeeze', rule: 'no new strangles' }], volSizeMult: 0.5 }));
    expect(r.red.map((x) => x.id)).toEqual(['compression']);
    expect(r.sizing.riskPct).toBe(CFG.riskPct * 0.5);
  });
});

describe('topTierReleases', () => {
  it('keeps high-impact US CPI/NFP/FOMC only', () => {
    const rows = [
      { title: 'CPI m/m', country: 'USD', impact: 'High', date: '2026-11-12T08:30:00-05:00' },
      { title: 'Non-Farm Employment Change', country: 'USD', impact: 'High', date: '2026-11-06T08:30:00-05:00' },
      { title: 'Retail Sales m/m', country: 'USD', impact: 'High', date: '2026-11-14T08:30:00-05:00' },
      { title: 'CPI y/y', country: 'EUR', impact: 'High', date: '2026-11-17T05:00:00-05:00' },
      { title: 'FOMC Member Speaks', country: 'USD', impact: 'Medium', date: '2026-11-05T10:00:00-05:00' },
    ];
    expect(topTierReleases(rows).map((r) => r.title)).toEqual(['CPI m/m', 'Non-Farm Employment Change']);
  });
});
