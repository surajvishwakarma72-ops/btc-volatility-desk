/**
 * YEAR CALENDAR GENERATOR — one rich rule-cell per calendar date, backtest-driven, strict 2×.
 * Trade EVERY weekday (Sat/Sun rest). No skips except the emergency panic band. Stops are logged
 * with their reason + the TIMING fix for next time (auto-improve) — never "skip next time".
 *
 * Emits frontend/public/data/strangle_calendar.js → window.__STRANGLE_CAL
 *   { span, summary, days: { 'YYYY-MM-DD': {v,dow,band,tone,iv,entry,exit,lots,out,pnl,move,why,fix} } }
 * The pictorial clock + the whole-year calendar + a future algo all render from this.
 *
 * Run: npx tsx src/backtest/steps/year_calendar.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const istHM = (tMs: number, D0: number) => { const h = Math.floor((tMs - D0) / HR), m = Math.round(((tMs - D0) % HR) / MIN); return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };

// IV band → label + tone (matches RULES.ivBands). The only emergency sit-out is the panic band.
function band(iv: number): { label: string; tone: string; emergency: boolean } {
  if (iv >= 65) return { label: 'PANIC', tone: 'red', emergency: true };
  if (iv >= 60) return { label: 'hot', tone: 'amber', emergency: false };
  if (iv >= 45) return { label: 'sweet', tone: 'green', emergency: false };
  if (iv >= 35) return { label: 'dead-zone', tone: 'amber', emergency: false };
  if (iv >= 25) return { label: 'calm', tone: 'green', emergency: false };
  return { label: 'thin', tone: 'amber', emergency: false };
}

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

function main() {
  const data = loadData();
  const days: Record<string, any> = {};
  let nTrade = 0, nStop = 0, nWin = 0, pnlSum = 0;

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const dayKey = dk(dayMs + 12 * HR);
    const f = frame(d0(dayKey) + 20 * HR);
    const dowName = DOW[f.dow];

    // Weekend = rest (the trader's own rule).
    if (f.dow < 1 || f.dow > 5) { days[dayKey] = { v: 'REST', dow: dowName, out: 'REST', why: 'Weekend off (your rule)' }; continue; }
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) { days[dayKey] = { v: 'NODATA', dow: dowName, out: 'NODATA', why: 'outside data span' }; continue; }

    // Entry = the IV turn (sell the turn, not the London-close spike). Fallback: window open.
    const isFri = f.dow === 5;
    const winOpen = f.D0 + (isFri ? 23 : 22) * HR;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    let entryT = sLab.hasEvent ? turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0) : null;
    const hadTurn = entryT != null;
    if (entryT == null || entryT < winOpen) entryT = Math.min(Math.max(entryT ?? winOpen, winOpen), f.exit - HR);
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) { days[dayKey] = { v: 'NODATA', dow: dowName, out: 'NODATA', why: 'no IV at entry' }; continue; }

    const bd = band(iv0);
    const lots = 100;
    // Emergency sit-out: panic band only.
    if (bd.emergency) {
      days[dayKey] = { v: 'EMERGENCY', dow: dowName, band: bd.label, tone: bd.tone, iv: +iv0.toFixed(1), lots: 0, out: 'STAND-DOWN', why: `IV ${iv0.toFixed(0)}% — panic band, the one emergency sit-out`, fix: 'wait for IV < 60 then resume' };
      continue;
    }

    const sim = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
    if (!sim.ok) { days[dayKey] = { v: 'NODATA', dow: dowName, out: 'NODATA', why: 'sim gap' }; continue; }

    nTrade++; pnlSum += sim.pnlPctMargin;
    let out: string, why: string, fix = '';
    if (sim.stopped) {
      nStop++;
      const leg = (sim.hurtLeg || '').toLowerCase();
      out = `SL-${leg.toUpperCase()}`;
      why = `${leg === 'put' ? 'Put' : 'Call'} leg hit 2× — BTC ran ${sim.btcMovePct >= 0 ? '+' : ''}${sim.btcMovePct.toFixed(1)}%`;
      fix = hadTurn ? 'enter ~30–60m later next time — let the London-close move exhaust before selling' : 'wait for a clear IV turn; do not sell into the window open';
    } else if (sim.pnlPctMargin > 0) {
      nWin++;
      out = sim.outcome === 'target' ? 'TARGET' : 'TIME-WIN';
      why = out === 'TARGET' ? 'hit 12% target — crush paid in full' : 'held to 07:00 in profit — crush decayed overnight';
    } else {
      out = 'TIME-FLAT'; why = 'held to 07:00 near scratch';
    }

    days[dayKey] = {
      v: 'TRADE', dow: dowName, band: bd.label, tone: bd.tone, iv: +iv0.toFixed(1),
      entry: istHM(entryT, f.D0), exit: istHM(f.exit, f.D0), lots,
      out, pnl: +sim.pnlPctMargin.toFixed(1), move: +sim.btcMovePct.toFixed(1), why, ...(fix ? { fix } : {}),
    };
  }

  const summary = {
    trades: nTrade, stopPct: +(nTrade ? (nStop / nTrade) * 100 : 0).toFixed(1),
    winPct: +(nTrade ? (nWin / nTrade) * 100 : 0).toFixed(1), avgPnl: +(nTrade ? pnlSum / nTrade : 0).toFixed(2),
    rule: 'strict 2× · 100 lots · trade every weekday · IV-turn entry · 12% target / 07:00 exit · panic-band = only sit-out',
  };

  const payload = { span: `${FIRST}..${LAST}`, generated: RULES_UPDATED, summary, days };
  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'strangle_calendar.js'), `window.__STRANGLE_CAL = ${JSON.stringify(payload)};\n`);

  console.log('='.repeat(92));
  console.log('YEAR CALENDAR — strict 2×, trade every weekday, no skips (panic band aside):');
  console.log('='.repeat(92));
  console.log(`  span ${payload.span} · ${summary.trades} trades · ${summary.stopPct}% stop · ${summary.winPct}% win · avg +${summary.avgPnl}%/trade`);
  const sample = Object.entries(days).filter(([, d]) => (d as any).v === 'TRADE').slice(0, 8);
  console.log('\n  sample cells:');
  for (const [date, d] of sample) {
    const x = d as any;
    console.log(`  ${date} ${x.dow}  IV ${String(x.iv).padStart(4)} ${x.band.padEnd(9)} enter ${x.entry} → ${x.exit}  ${x.out.padEnd(9)} ${((x.pnl >= 0 ? '+' : '') + x.pnl).padStart(6)}%  ${x.why}${x.fix ? '  ⟳ ' + x.fix : ''}`);
  }
  console.log(`\n[year_calendar] wrote frontend/public/data/strangle_calendar.js (window.__STRANGLE_CAL) — ${Object.keys(days).length} dates.`);
}

const RULES_UPDATED = '2026-10-21';
main();
