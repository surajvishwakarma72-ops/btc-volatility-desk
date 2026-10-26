import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Bot page's PnL charts live in frontend/index.html between PNLCHART markers; these tests run that exact code. */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// PNLCHART-START'), b = html.indexOf('// PNLCHART-END');
if (a < 0 || b < 0) throw new Error('PNLCHART markers not found in frontend/index.html');
const C = new Function(`${html.slice(a, b)}\nreturn { minuteChart, equityChart, indexAt, placeAt, minuteReadout, equityReadout, tradeTiles, allTiles, ticks };`)() as any;

const MIN = 60_000, T0 = Date.parse('2026-10-26T04:30:00Z');
const net = [0, 2, 5, 9, 7, 4, -1, 3, 8, 6];
const trade = {
  run: { id: 'r', strategy: 'ASIA_SHORT', status: 'closed', margin: 200, feesEntry: 0.9, feesExit: 0.9, net: 6, gross: 7.8, exitReason: 'tp', dateKey: '2026-10-26' },
  t: net.map((_, i) => T0 + i * MIN), net, gross: net.map((v) => v + 1.8), spot: net.map((_, i) => 80_000 + i), pct: net.map((v) => v / 200),
  legs: [{ symbol: 'C-BTC-82000-261027', side: 'short', role: 'body', entry: 100, mark: net.map((v) => 100 - v), pnl: net.map((v) => v / 2), iv: net.map(() => 38), delta: net.map(() => 0.12) }],
  tp: 20, stops: [],
  stats: { minutes: 10, holdMin: 9, peak: { net: 9, t: T0 + 3 * MIN, atMin: 3 }, trough: { net: -1, t: T0 + 6 * MIN, atMin: 6 }, gaveBack: 3, maxDrawdown: { amount: 10, fromT: T0 + 3 * MIN, toT: T0 + 6 * MIN }, timeInProfitPct: 80, biggestMinute: { change: 4, t: T0 + 3 * MIN }, avgAbsMinute: 2.5, gapMinutes: 0 },
};

describe('minute chart with a hairline', () => {
  const ch = C.minuteChart(trade, 'pcT');
  it('draws the line, zero, the take-profit level, entry, best, worst and the exit with its reason', () => {
    expect(ch.html).toContain('class="pcSvg"');
    expect(ch.html).toContain('polyline');
    expect(ch.html).toContain('take profit $20');
    expect(ch.html).toContain('entry');
    expect(ch.html).toContain('best $9.00');
    expect(ch.html).toContain('worst -$1.00');
    expect(ch.html).toContain('exit: take profit');
    expect(ch.html).toContain('id="pcTL"'); // the hairline
    expect(ch.html).toContain('id="pcTD"'); // its dot
    expect(ch.html).not.toMatch(/NaN|undefined/);
  });
  it('finds the nearest minute under a pointer and puts the hairline exactly on that point', () => {
    const m = ch.meta;
    for (let i = 0; i < 10; i++) {
      const pl = C.placeAt(m, trade, i);
      expect(C.indexAt(m, pl.x)).toBe(i);
      expect(C.indexAt(m, pl.x + 1.4)).toBe(i); // a pixel or two off still lands on the same minute
    }
    expect(C.indexAt(m, -500)).toBe(0);
    expect(C.indexAt(m, 5000)).toBe(9);
    expect(C.placeAt(m, trade, 3).label).toBe('10:03'); // IST
    expect(C.placeAt(m, trade, 3).y).toBeLessThan(C.placeAt(m, trade, 0).y); // higher PnL, higher on the screen
  });
  it('the readout for a minute has its time, net, gross, the change from the minute before, the best so far and each leg', () => {
    const r = C.minuteReadout(trade, 6);
    expect(r).toContain('10-26 10:06'); // 04:36 UTC is 10:06 IST
    expect(r).toContain('-$1.00');
    expect(r).toContain('-0.5% of margin');
    expect(r).toContain('-5.00'); // 4 then -1: five dollars down in that minute
    expect(r).toContain('now $10.00 below it'); // the best so far was 9
    expect(r).toContain('C-82000-261027');
  });
  it('says what a bar of tiles says about the whole trade, honestly', () => {
    const tiles = C.tradeTiles(trade);
    expect(tiles).toContain('Best moment');
    expect(tiles).toContain('after 3 min');
    expect(tiles).toContain('between 10:03 and 10:06');
    expect(tiles).toContain('80%');
    expect(tiles).toContain('exit: take profit');
  });
  it('needs at least two minutes before it draws anything', () => {
    expect(C.minuteChart({ t: [T0], net: [1] }, 'x').meta).toBeNull();
    expect(C.minuteChart({ t: [], net: [] }, 'x').html).toMatch(/Not enough minutes/);
  });
  it('escapes names that came from data', () => {
    const evil = { ...trade, legs: [{ ...trade.legs[0], symbol: '<img src=x onerror=alert(1)>' }] };
    expect(C.minuteReadout(evil, 2)).not.toContain('<img');
  });
});

describe('equity chart with drawdown', () => {
  const eq = [8, -3, 5, 12, -20, 6].reduce<any[]>((acc, x, i) => { const cum = (acc[i - 1]?.cum ?? 0) + x, hi = Math.max(0, ...acc.map((p) => p.cum), cum); acc.push({ n: i + 1, id: 'e' + i, strategy: 'ASIA_SHORT', dateKey: '2026-10-' + (10 + i), exitMs: T0 + i * 86_400_000, net: x, cum, dd: hi - cum, reason: x > 0 ? 'tp' : 'stop' }); return acc; }, []);
  const E = { equity: eq, stats: { trades: 6, wins: 4, losses: 2, winRate: 4 / 6, netTotal: 8, feesTotal: 12, avgWin: 7.75, avgLoss: -11.5, payoff: 0.67, profitFactor: 1.35, expectancy: 1.33, best: { net: 12, dateKey: '2026-10-13' }, worst: { net: -20, dateKey: '2026-10-14' }, maxDrawdown: { amount: 20, fromN: 4, toN: 5 }, longestWinStreak: 1, longestLossStreak: 1, avgHoldMin: 60, avgReturnOnMargin: 0.01 } };
  const ch = C.equityChart(E, 'pcE');
  it('draws the curve, dots coloured by result, the drawdown bars and the hairline', () => {
    expect(ch.html).toContain('polyline');
    expect(ch.html).toContain('Drawdown');
    expect(ch.html).toContain('id="pcEL"');
    expect(ch.html).not.toMatch(/NaN|undefined/);
  });
  it('maps pointer to trade and back, and the readout names the trade, its result, the total and the drawdown', () => {
    for (let i = 0; i < 6; i++) { const pl = C.placeAt(ch.meta, E, i); expect(C.indexAt(ch.meta, pl.x)).toBe(i); }
    const r = C.equityReadout(E, 4);
    expect(r).toContain('#5 of 6');
    expect(r).toContain('-$20.00');
    expect(r).toMatch(/Total so far<\/span><b class="pos">\$2\.00/); // 8 - 3 + 5 + 12 - 20
    expect(r).toMatch(/Below its high<\/span><b class="neg">\$20\.00/); // the high was 22
  });
  it('shows the run statistics, with no profit factor invented before a loss', () => {
    const t = C.allTiles(E.stats);
    expect(t).toContain('67%');
    expect(t).toContain('Max drawdown');
    expect(t).toContain('trade #4 to #5');
    expect(C.allTiles({ ...E.stats, profitFactor: null })).toContain('no loss yet');
    expect(C.allTiles({ trades: 0 })).toMatch(/No closed trades/);
  });
});
