import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dvol: 40 as number | null,
  macro: { zone: 'calm', score: 20, nextEvent: 'No Tier-1 US news in 6h', hasData: true, status: 'ok' } as any,
}));
vi.mock('../deribit-flow-worker.js', () => ({ deribitWorker: { get currentDvol() { return h.dvol; } } }));
vi.mock('../macro-stress-worker.js', () => ({ macroStressWorker: { getSnapshot: () => h.macro } }));

const { evaluateGate } = await import('./gate.js');

beforeEach(() => {
  h.dvol = 40;
  h.macro = { zone: 'calm', score: 20, nextEvent: 'No Tier-1 US news in 6h', hasData: true, status: 'ok' };
});

describe('bot gate', () => {
  it('says GO only with a measured calm macro reading and DVOL under the limit', () => {
    expect(evaluateGate()).toMatchObject({ go: true, reasons: [] });
    expect(evaluateGate(35).reasons[0]).toMatch(/DVOL 40\.0 >= 35/);
  });

  it('never passes on a macro reading that was not measured or whose feeds are failing', () => {
    h.macro = { ...h.macro, hasData: false };
    expect(evaluateGate()).toMatchObject({ go: false });
    expect(evaluateGate().reasons.join(' ')).toMatch(/macro data not loaded yet/);
    h.macro = { zone: 'calm', score: 20, nextEvent: 'x', hasData: true, status: 'degraded' };
    expect(evaluateGate().reasons.join(' ')).toMatch(/macro feeds degraded/);
  });

  it('waits on an elevated zone, on missing DVOL, and treats "loading" as unknown rather than "no event"', () => {
    h.macro = { ...h.macro, zone: 'elevated' };
    expect(evaluateGate().reasons.join(' ')).toMatch(/macro zone elevated/);
    h.macro = { zone: 'calm', score: 20, nextEvent: 'CPI y/y (in 2.0h)', hasData: true, status: 'ok' };
    expect(evaluateGate().eventInWindow).toBe(true);
    h.macro = { zone: 'calm', score: 20, nextEvent: 'loading', hasData: false, status: 'degraded' };
    expect(evaluateGate().eventInWindow).toBe(false);
    h.dvol = null;
    expect(evaluateGate().reasons).toContain('DVOL unavailable');
  });
});
