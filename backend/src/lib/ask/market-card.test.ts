import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../bot/futures.js';
import { buildMarketReport, type MarketReport, type ReportInput } from '../algo/market-report.js';

/**
 * "market condition" in Ask me: the command that opens it, and the card that draws the answer. Both live in frontend/index.html, and
 * these tests run that exact code: the parser from the ASKTRADE-CORE block and marketCard itself, fed with a real report.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// ASKTRADE-CORE-START'), b = html.indexOf('// ASKTRADE-CORE-END');
if (a < 0 || b < 0) throw new Error('ASKTRADE markers not found in frontend/index.html');
const T = new Function(`${html.slice(a, b)}\nreturn { parseTrade };`)() as { parseTrade(q: string, pending?: string | null): { kind: string } | null };

const ma = html.indexOf('function marketCard(r) {'), mb = html.indexOf('/** The auto recommendation: a verdict');
if (ma < 0 || mb < ma) throw new Error('marketCard not found in frontend/index.html');
const esc = (x: unknown) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const marketCard = new Function('esc', `${html.slice(ma, mb)}\nreturn marketCard;`)(esc) as (r: MarketReport) => string;

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function bars(): Bar[] {
  const n = 6 * 288, r = rng(11), out: Bar[] = [];
  let prev = 80_000;
  for (let i = 0; i < n; i++) { const c = 80_000 + (r() - 0.5) * 120, w = 8 + r() * 10; out.push({ t: NOW - (n - i) * 300_000, o: prev, h: Math.max(prev, c) + w, l: Math.min(prev, c) - w, c, v: 100 }); prev = c; }
  return out;
}
const report = (over: Partial<ReportInput> = {}): MarketReport => {
  const bs = bars();
  return buildMarketReport({ nowMs: NOW, spot: bs[bs.length - 1]!.c, bars5m: bs, atmIv: 70, dvol: 55, gateGo: true, gateReasons: [], hist: [], clock: null,
    atm: { expiryLabel: '28 Oct', hoursLeft: 30, strike: 80_000, iv: 70, gamma: 0.00012, theta: -150, straddle: 1500 },
    legs: [{ type: 'call', strike: 82_400, delta: 0.12, gamma: 0.00003, iv: 72, price: 60 }, { type: 'put', strike: 77_600, delta: 0.12, gamma: 0.00003, iv: 74, price: 70 }], ...over });
};

describe('the command that opens it', () => {
  it('understands the usual ways of asking for the market condition', () => {
    for (const q of ['market condition', 'market conditions', 'Market Condition', 'show market condition', 'show me the market condition', 'what is the market condition', "what's the market condition now", 'market view', 'market summary', 'market status',
      'btc market condition', "today's market condition", 'how is the market', "how's the market today", 'is the market good for a short strangle', 'is market good for strangle', 'please show market overview', 'market condition?', 'should i sell a short strangle']) {
      expect(T.parseTrade(q), q).toMatchObject({ kind: 'market' });
    }
  });
  it('does not grab other questions, and leaves entry and exit alone', () => {
    for (const q of ['market', 'market maker', 'why did the market move', 'market order', 'entry 50', 'exit', 'exit live']) expect(T.parseTrade(q)?.kind, q).not.toBe('market');
    expect(T.parseTrade('entry 50')).toMatchObject({ kind: 'entry' });
    expect(T.parseTrade('exit')).toMatchObject({ kind: 'exit' });
  });
});

describe('the card that draws it', () => {
  it('draws the verdict, the trend meter, the price chart and one tile for every indicator', () => {
    const r = report(), h = marketCard(r);
    expect(h).toMatch(/GO<\/span>/);
    expect(h).toContain('aria-label="Trend: sideways"');
    expect(h).toContain('aria-label="BTC price, last 16 hours"');
    expect(h).toContain('Implied against realised volatility');
    expect((h.match(/border-left:4px solid/g) ?? []).length).toBe(r.tiles.length);
    expect(h).toContain('Final recommendation: GO for a short strangle');
    expect(h).toContain('What gets a strangle to its target');
    expect(h).toContain('What gets it to its stop');
    for (const label of ['Trend direction', 'Trend strength', 'Momentum', 'Price volatility', 'Implied volatility', 'Desk gate']) expect(h, label).toContain(label);
  });

  it('shows WAIT or AVOID in the right words when the market is not suitable', () => {
    expect(marketCard(report({ gateGo: false, gateReasons: ['NY open'] }))).toMatch(/(WAIT|AVOID)<\/span>/);
    expect(marketCard(report({ atmIv: 5 }))).toContain('gamma is winning');
  });

  it('shows the short legs against the ATM: gamma share, IV difference and distance in standard moves', () => {
    const h = marketCard(report());
    expect(h).toContain('call 82400');
    expect(h).toContain('25.0%');
    expect(h).toMatch(/σ/);
  });

  it('never lets text from the data become markup', () => {
    const h = marketCard(report({ gateGo: false, gateReasons: ['<img src=x onerror=alert(1)>'] }));
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('still draws something sensible with no candles and no chain', () => {
    const r = buildMarketReport({ nowMs: NOW, spot: 80_000, bars5m: [], atmIv: null, dvol: null, gateGo: null, gateReasons: [], atm: null, legs: null });
    const h = marketCard(r);
    expect(h).toContain('Not enough candles to draw the chart yet');
    expect(h).toMatch(/WAIT<\/span>/);
  });
});
