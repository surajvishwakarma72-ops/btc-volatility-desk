import { describe, expect, it } from 'vitest';
import { evaluateExit } from './rules.js';
import type { ExitConfig, Leg, PositionSnapshot } from './types.js';

const leg = (symbol: string, entry: number, role: Leg['role'] = 'body', side: Leg['side'] = 'short'): Leg => ({ symbol, type: symbol.startsWith('C') ? 'call' : 'put', side, strike: 80000, expiryMs: 1, lots: 100, entryPrice: entry, role });
const snap = (marks: Record<string, number>, legs: Leg[]): PositionSnapshot => ({ legs, marks: Object.entries(marks).map(([symbol, mark]) => ({ symbol, mark })), spot: 80000, marginUsd: 200, contractValue: 0.001, feesPaidUsd: 1 });
const legs = [leg('C-82000', 100), leg('P-78000', 120)];
const cfg = (hardPoints?: number): ExitConfig => ({ stopMultiple: 2, tpPctOfMargin: 5, hardPoints });

describe('the bot\'s hard exit: out a few points before the 2x stop', () => {
  it('a call sold at 100 with a stop at 200: holds at 194.9, exits at 195 (5 points left) and names it a hard exit', () => {
    expect(evaluateExit(snap({ 'C-82000': 194.9, 'P-78000': 90 }, legs), cfg(5), 0)).toEqual({ action: 'hold' });
    const d = evaluateExit(snap({ 'C-82000': 195, 'P-78000': 90 }, legs), cfg(5), 0);
    expect(d).toMatchObject({ action: 'exit', reason: 'stop' });
    expect((d as any).detail).toMatch(/hard exit: C-82000 mark 195.00 was within 5 points of its stop 200.00/);
  });
  it('either leg can trigger it, and one trigger closes the whole position', () => {
    const d = evaluateExit(snap({ 'C-82000': 120, 'P-78000': 236 }, legs), cfg(5), 0); // the put's stop is 240
    expect(d).toMatchObject({ action: 'exit', reason: 'stop' });
    expect((d as any).detail).toMatch(/P-78000/);
  });
  it('at or past the stop it is the ordinary stop, with the ordinary wording', () => {
    expect((evaluateExit(snap({ 'C-82000': 201, 'P-78000': 90 }, legs), cfg(5), 0) as any).detail).toMatch(/reached 2x entry 100.00/);
  });
  it('without hard points it behaves exactly as before: only the stop itself closes it', () => {
    expect(evaluateExit(snap({ 'C-82000': 199, 'P-78000': 90 }, legs), cfg(), 0)).toEqual({ action: 'hold' });
    expect(evaluateExit(snap({ 'C-82000': 199, 'P-78000': 90 }, legs), cfg(0), 0)).toEqual({ action: 'hold' });
    expect(evaluateExit(snap({ 'C-82000': 200, 'P-78000': 90 }, legs), cfg(0), 0)).toMatchObject({ action: 'exit', reason: 'stop' });
  });
  it('bought legs and back legs never trigger it', () => {
    const l = [leg('C-82000', 100), leg('C-86000', 10, 'back', 'long')];
    expect(evaluateExit(snap({ 'C-82000': 120, 'C-86000': 19.5 }, l), cfg(5), 0)).toEqual({ action: 'hold' });
  });
});
