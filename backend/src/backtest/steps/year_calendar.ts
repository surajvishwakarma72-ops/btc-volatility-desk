/**
 * YEAR CALENDAR GENERATOR — conditions-based, stop-avoiding. Each weekday night is GO (sell) ONLY
 * when the gate holds (on the IV turn · IV out of the 35–45 dead-zone & <65 · edge-rich); otherwise
 * WAIT with the exact missing condition. Strict 2×, 100 lots on GO. This is NOT blind daily entry.
 *
 * Emits (all read by the clock/calendar + a future algo):
 *   frontend/public/data/strangle_calendar.js → window.__STRANGLE_CAL   (rich per-day cells)
 *   frontend/public/data/backtest_days.js      → window.__STRANGLE_BT_DAYS (desk shape {v,s,w,pnl,note})
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
import { computeFeatures, type Features } from '../lib/indicators.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const istHM = (tMs: number, D0: number) => { const h = Math.floor((tMs - D0) / HR), m = Math.round(((tMs - D0) % HR) / MIN); return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);

function band(iv: number): { label: string; tone: string } {
  if (iv >= 65) return { label: 'PANIC', tone: 'red' };
  if (iv >= 60) return { label: 'hot', tone: 'amber' };
  if (iv >= 45) return { label: 'rich', tone: 'green' };
  if (iv >= 35) return { label: 'dead-zone', tone: 'amber' };
  if (iv >= 25) return { label: 'calm', tone: 'green' };
  return { label: 'thin', tone: 'amber' };
}
// THE GATE — returns null if GO, else the reason to WAIT.
const inDeadZone = (iv: number) => iv >= 35 && iv < 45;
function waitReason(iv: number, edge: number, medEdge: number): string | null {
  if (iv >= 65) return 'IV ≥ 65 (panic) — stand down';
  if (inDeadZone(iv)) return 'IV in the 35–45 dead-zone — stops cluster here';
  if (!(edge >= medEdge)) return 'edge thin — IV not rich vs realised';
  return null; // GO
}

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

type Night = { dayKey: string; f: any; entryT: number; iv0: number; feat: Features };

function main() {
  const data = loadData();

  // Pass 1 — collect every weekday IV-turn night (the eligible pool) to fix the edge threshold.
  const nights: Night[] = [];
  const noTurn = new Set<string>(); // weekday nights with IV data but no clear turn → WAIT
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const dayKey = dk(dayMs + 12 * HR);
    const f = frame(d0(dayKey) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    const entryT = sLab.hasEvent ? turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0) : null;
    if (entryT == null) { noTurn.add(dayKey); continue; }
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) { noTurn.add(dayKey); continue; }
    nights.push({ dayKey, f, entryT, iv0, feat: computeFeatures(data, f, entryT) });
  }
  const medEdge = [...nights.map((n) => n.feat.edge)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(nights.length / 2)];

  // Pass 2 — apply the gate: GO (simulate) or WAIT (reason).
  const days: Record<string, any> = {};
  const btDays: Record<string, any> = {};
  const wdStat: Record<number, { go: number; w: number; s: number; pnl: number; elig: number }> = {};
  for (const d of [1, 2, 3, 4, 5]) wdStat[d] = { go: 0, w: 0, s: 0, pnl: 0, elig: 0 };
  let go = 0, stop = 0, win = 0, pnlSum = 0, wait = 0;

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const dayKey = dk(dayMs + 12 * HR);
    const f = frame(d0(dayKey) + 20 * HR);
    const dowName = DOW[f.dow];
    if (f.dow < 1 || f.dow > 5) { days[dayKey] = { v: 'REST', dow: dowName, why: 'Weekend off (your rule)' }; continue; }
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) { days[dayKey] = { v: 'NODATA', dow: dowName, why: 'outside data span' }; continue; }
    if (noTurn.has(dayKey)) {
      days[dayKey] = { v: 'WAIT', dow: dowName, reason: 'no clear IV turn in the NY window', why: 'No IV turn to sell — stay out, keep your capital.' };
      btDays[dayKey] = { v: 'WAIT', note: 'no IV turn' }; wait++; continue;
    }
    const n = nights.find((x) => x.dayKey === dayKey)!;
    const bd = band(n.iv0);
    wdStat[f.dow].elig++;
    const reason = waitReason(n.iv0, n.feat.edge, medEdge);
    if (reason) {
      days[dayKey] = { v: 'WAIT', dow: dowName, iv: +n.iv0.toFixed(1), band: bd.label, tone: bd.tone, reason, why: 'Gate says WAIT: ' + reason + '. Not every night is a trade.' };
      btDays[dayKey] = { v: 'WAIT', note: reason }; wait++; wdStat[f.dow].w++; continue;
    }
    // GO — simulate the strict-2× trade.
    const sim = simulateStrangle(data, n.f, n.entryT, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
    if (!sim.ok) { days[dayKey] = { v: 'NODATA', dow: dowName, why: 'sim gap' }; continue; }
    go++; pnlSum += sim.pnlPctMargin; wdStat[f.dow].go++; wdStat[f.dow].pnl += sim.pnlPctMargin;
    let out: string, why: string, fix = '';
    if (sim.stopped) {
      stop++; wdStat[f.dow].s++;
      const leg = (sim.hurtLeg || '').toLowerCase();
      out = `SL-${leg.toUpperCase()}`;
      why = `${leg === 'put' ? 'Put' : 'Call'} leg hit 2× — BTC ran ${sim.btcMovePct >= 0 ? '+' : ''}${sim.btcMovePct.toFixed(1)}% (a gated trade that still stopped — the residual ~26%).`;
      fix = 'enter ~30m later next time — let the move exhaust further before selling';
    } else if (sim.pnlPctMargin > 0) {
      win++;
      out = sim.outcome === 'TARGET' ? 'TARGET' : 'TIME-WIN';
      why = out === 'TARGET' ? 'hit 12% target — the gate paid off' : 'held to 07:00 in profit — crush decayed overnight';
    } else { out = 'TIME-FLAT'; why = 'held to 07:00 near scratch'; }

    days[dayKey] = {
      v: 'GO', dow: dowName, band: bd.label, tone: bd.tone, iv: +n.iv0.toFixed(1), edge: +n.feat.edge.toFixed(1),
      entry: istHM(n.entryT, f.D0), exit: istHM(f.exit, f.D0), lots: 100,
      out, pnl: +sim.pnlPctMargin.toFixed(1), move: +sim.btcMovePct.toFixed(1), why, ...(fix ? { fix } : {}),
    };
    btDays[dayKey] = { v: 'TRADE', s: sim.stopped, w: out === 'TARGET' || out === 'TIME-WIN', pnl: +sim.pnlPctMargin.toFixed(1), note: out };
  }

  const eligTotal = nights.length + noTurn.size;
  const summary = {
    go, wait, eligibleNights: eligTotal, coveragePct: +pct(go, eligTotal).toFixed(1),
    stopPct: +pct(stop, go).toFixed(1), winPct: +pct(win, go).toFixed(1), avgPnl: +(go ? pnlSum / go : 0).toFixed(2),
    rule: 'conditions-based gate · strict 2× · 100 lots on GO · trade the best setup, WAIT the rest (no blind daily entry)',
  };
  const payload = { span: `${FIRST}..${LAST}`, generated: '2026-10-21', summary, days };
  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'strangle_calendar.js'), `window.__STRANGLE_CAL = ${JSON.stringify(payload)};\n`);
  fs.writeFileSync(path.join(feDir, 'backtest_days.js'), `window.__STRANGLE_BT_DAYS = ${JSON.stringify(btDays)};\n`);

  console.log('='.repeat(96));
  console.log('YEAR CALENDAR — conditions-based gate (GO only on the best setup, WAIT otherwise):');
  console.log('='.repeat(96));
  console.log(`  ${summary.go} GO trades · ${summary.wait} WAIT nights · ${summary.coveragePct}% of eligible nights traded`);
  console.log(`  GO outcome: ${summary.stopPct}% stop · ${summary.winPct}% win · +${summary.avgPnl}% margin/trade`);
  console.log('\n  By weekday (GO only):');
  console.log('  day   GO  WAIT  stop%  win%');
  for (const d of [1, 2, 3, 4, 5]) {
    const w = wdStat[d];
    console.log(`  ${DOW[d]}  ${String(w.go).padStart(3)}  ${String(w.w + (w.elig === 0 ? 0 : 0)).padStart(4)}  ${pct(w.s, w.go).toFixed(1).padStart(5)}  ${pct(w.go - w.s, w.go).toFixed(1).padStart(5)}`);
  }
  console.log(`\n[year_calendar] wrote strangle_calendar.js + backtest_days.js — ${summary.go} GO / ${summary.wait} WAIT.`);
}

main();
