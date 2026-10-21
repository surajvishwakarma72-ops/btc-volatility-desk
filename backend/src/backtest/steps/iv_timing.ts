/**
 * IV-FALL TIMING & REAL-vs-FAKE-FEAR ANALYSIS (short strangle, N2N expiry, 0.10-0.15Δ).
 *
 * Question: when does ATM IV *actually* fall (keep falling = safe to sell = user's "fake fear")
 * vs fall-then-bounce (trap/stop = user's "real fear")? Entry = when IV turns down inside a
 * session; exit = 07:00 IST; per-leg 2× premium stop. Skips Sat/Sun nights for the strategy tables.
 *
 * Reuses: load.ts (real Binance candles + minute ATM-IV archive + DVOL), frame.ts (session/N2N
 * math), signals.classifyCrush (CRUSH=kept falling / REBOUND=bounced), simulate.ts (strangle sim).
 *
 * Output (printed): session table (Asia/London/NY), day-of-week, week-of-month, month, and a
 * delta-sensitivity row (0.10 vs 0.125 vs 0.15). Run: npx tsx src/backtest/steps/iv_timing.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM, type SimConfig } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';
import type { BacktestData } from '../data/load.js';

const FIRST = '2025-10-06';
const LAST = '2026-10-17';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Session windows as [startHr, endHr] in IST hours from the day's D0 (00:00 IST).
// Standard crypto/FX desk convention; NY runs past midnight into the next morning.
const SESSIONS: Record<string, [number, number]> = {
  Asia: [5.5, 13.0],   // 05:30–13:00 IST (Tokyo)
  London: [13.0, 18.5], // 13:00–18:30 IST
  NY: [18.5, 25.5],    // 18:30 IST → 01:30 IST next day (NY cash session)
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => x.toFixed(1);

interface Rec {
  day: string; dow: number; month: string; wom: number; session: string;
  fell: boolean;                 // IV peaked then fell ≥2pts WITHIN this session
  entered: boolean;              // a turn-down entry was taken
  stopped: boolean;
  pnlPctMargin: number;
  label: 'CRUSH' | 'REBOUND' | 'NO-EVENT'; // over the HOLD: kept falling vs bounced back by 07:00
}

/** First 15m after the session peak where IV has fallen ≥turnPts (IV "starts falling"). */
function turnEntry(data: BacktestData, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT);
  if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t);
    if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

function run(cfg: SimConfig): Rec[] {
  const data = loadData();
  const recs: Rec[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const month = day.slice(0, 7);
    const dom = new Date(day).getUTCDate();
    const wom = Math.min(5, Math.floor((dom - 1) / 7) + 1);

    for (const [sess, [sh, eh]] of Object.entries(SESSIONS)) {
      const sStart = f.D0 + sh * HR;
      const sEnd = f.D0 + eh * HR;
      // Did IV peak then fall ≥2pts WITHIN this session?
      const sSeries = data.ivWindow(f.n2n, sStart, sEnd);
      const sLab = classifyCrush(sSeries, sStart, sEnd, sEnd);
      let entered = false, stopped = false, pnl = 0;
      let label: Rec['label'] = 'NO-EVENT';
      if (sLab.hasEvent) {
        const entryT = turnEntry(data, f.n2n, sLab.peakT, sEnd, 1.0);
        if (entryT != null) {
          const sim = simulateStrangle(data, f, entryT, cfg);
          if (sim.ok) {
            entered = true; stopped = sim.stopped; pnl = sim.pnlPctMargin;
            // Real vs fake over the HOLD (entry → 07:00): kept falling (CRUSH) vs bounced (REBOUND).
            const hold = classifyCrush(data.ivWindow(f.n2n, entryT, f.exit), entryT, entryT + 30 * MIN, f.exit);
            label = hold.label === 'NO-EVENT' ? (stopped ? 'REBOUND' : 'CRUSH') : hold.label;
          }
        }
      }
      recs.push({ day, dow: f.dow, month, wom, session: sess, fell: sLab.hasEvent, entered, stopped, pnlPctMargin: pnl, label });
    }
  }
  return recs;
}

interface Summ { tot: number; fellPct: number; n: number; stopPct: number; winPct: number; keptPct: number; bouncedPct: number; avgSL: number; avgPnL: number; }
function summ(group: Rec[]): Summ {
  const tot = group.length;
  const fell = group.filter((r) => r.fell).length;
  const ent = group.filter((r) => r.entered);
  const n = ent.length;
  const stopped = ent.filter((r) => r.stopped);
  return {
    tot, fellPct: pct(fell, tot), n,
    stopPct: pct(stopped.length, n),
    winPct: pct(ent.filter((r) => r.pnlPctMargin > 0).length, n),
    keptPct: pct(ent.filter((r) => r.label === 'CRUSH').length, n),
    bouncedPct: pct(ent.filter((r) => r.label === 'REBOUND').length, n),
    avgSL: mean(stopped.map((r) => r.pnlPctMargin)),
    avgPnL: mean(ent.map((r) => r.pnlPctMargin)),
  };
}

function header(firstCol: string) {
  console.log(`  ${firstCol.padEnd(10)}  nights  IVfell%  n   Kept%(safe) Bncd%(trap) Stop%  avgSL%  Win%  avgPnL%`);
}
function row(firstCol: string, s: Summ, tag = '') {
  console.log(
    `  ${firstCol.padEnd(10)}  ${String(s.tot).padStart(5)}  ${f1(s.fellPct).padStart(6)}  ${String(s.n).padStart(3)}  ` +
    `${f1(s.keptPct).padStart(9)}  ${f1(s.bouncedPct).padStart(9)}  ${f1(s.stopPct).padStart(5)}  ${f1(s.avgSL).padStart(6)}  ${f1(s.winPct).padStart(5)}  ${f1(s.avgPnL).padStart(6)}  ${tag}`,
  );
}

/** Weekday × fixed-entry-time heatmap for the NY session, to find the best clock time to sell. */
function nyHeatmap(cfg: SimConfig) {
  const data = loadData();
  const OFFS = [0, 1, 2, 3, 4, 5, 6]; // hours from NY open (≈19:00 IST EDT)
  const label = (o: number) => String((19 + o) % 24).padStart(2, '0') + ':00';
  const pnl: Record<number, Record<number, number[]>> = {};
  const stop: Record<number, Record<number, number>> = {};
  const win: Record<number, Record<number, number>> = {};
  for (let d = 1; d <= 5; d++) { pnl[d] = {}; stop[d] = {}; win[d] = {}; for (const o of OFFS) { pnl[d][o] = []; stop[d][o] = 0; win[d][o] = 0; } }

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    for (const o of OFFS) {
      const entryT = f.open + o * HR;
      if (entryT >= f.exit || data.ivAt(f.n2n, entryT) == null) continue;
      const sim = simulateStrangle(data, f, entryT, cfg);
      if (!sim.ok) continue;
      pnl[f.dow][o].push(sim.pnlPctMargin);
      if (sim.stopped) stop[f.dow][o]++;
      if (sim.pnlPctMargin > 0) win[f.dow][o]++;
    }
  }

  const colhead = '  weekday ' + OFFS.map((o) => label(o).padStart(8)).join('');
  console.log('\n6) NY BEST-ENTRY HEATMAP — sell at a fixed IST time each night, hold to 07:00 (avg PnL % of margin; * = best time that day):');
  console.log('   (columns = entry clock time IST, NY-open basis; hold is always to the 07:00 exit)');
  console.log(colhead);
  for (let d = 1; d <= 5; d++) {
    const avgs = OFFS.map((o) => mean(pnl[d][o]));
    const best = Math.max(...avgs);
    const cells = OFFS.map((o, i) => { const v = avgs[i]; const s = (i === avgs.indexOf(best) ? '*' : '') + (v >= 0 ? '+' : '') + f1(v); return s.padStart(8); });
    console.log('  ' + DOW[d].padEnd(7) + ' ' + cells.join(''));
  }
  console.log('\n   Win% by entry time:');
  console.log(colhead);
  for (let d = 1; d <= 5; d++) {
    const cells = OFFS.map((o) => f1(pct(win[d][o], pnl[d][o].length)).padStart(8));
    console.log('  ' + DOW[d].padEnd(7) + ' ' + cells.join(''));
  }
  console.log('\n   Stop% by entry time:');
  console.log(colhead);
  for (let d = 1; d <= 5; d++) {
    const cells = OFFS.map((o) => f1(pct(stop[d][o], pnl[d][o].length)).padStart(8));
    console.log('  ' + DOW[d].padEnd(7) + ' ' + cells.join(''));
  }
  console.log('\n   → Best NY entry per weekday (max avg PnL%):');
  for (let d = 1; d <= 5; d++) {
    const r = OFFS.map((o) => ({ o, v: mean(pnl[d][o]), n: pnl[d][o].length, st: pct(stop[d][o], pnl[d][o].length), w: pct(win[d][o], pnl[d][o].length) })).sort((a, b) => b.v - a.v)[0];
    console.log(`     ${DOW[d]}: ${label(r.o)} IST → avgPnL ${(r.v >= 0 ? '+' : '') + f1(r.v)}%, win ${f1(r.w)}%, stop ${f1(r.st)}% (n=${r.n})`);
  }
}

/** NY entry-time heatmaps grouped by week-of-month and by month (weekday nights only). */
function nyHeatmapExtra(cfg: SimConfig) {
  const data = loadData();
  const OFFS = [0, 1, 2, 3, 4, 5, 6];
  const label = (o: number) => String((19 + o) % 24).padStart(2, '0') + ':00';
  interface C { wom: number; month: string; off: number; pnl: number; stopped: boolean; win: boolean; }
  const cells: C[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const dom = new Date(day).getUTCDate();
    const wom = Math.min(5, Math.floor((dom - 1) / 7) + 1);
    for (const o of OFFS) {
      const entryT = f.open + o * HR;
      if (entryT >= f.exit || data.ivAt(f.n2n, entryT) == null) continue;
      const sim = simulateStrangle(data, f, entryT, cfg);
      if (!sim.ok) continue;
      cells.push({ wom, month: day.slice(0, 7), off: o, pnl: sim.pnlPctMargin, stopped: sim.stopped, win: sim.pnlPctMargin > 0 });
    }
  }
  const colhead = '  ' + 'group'.padEnd(9) + OFFS.map((o) => label(o).padStart(8)).join('');
  const render = (title: string, rows: { key: string; test: (c: C) => boolean }[]) => {
    console.log(`\n${title} — avg PnL % of margin (★ = best entry that row):`);
    console.log(colhead);
    for (const r of rows) {
      const avgs = OFFS.map((o) => mean(cells.filter((c) => r.test(c) && c.off === o).map((c) => c.pnl)));
      const bi = avgs.indexOf(Math.max(...avgs));
      console.log('  ' + r.key.padEnd(9) + OFFS.map((o, i) => ((i === bi ? '★' : '') + (avgs[i] >= 0 ? '+' : '') + f1(avgs[i])).padStart(8)).join(''));
    }
    console.log('   Stop% by entry time:');
    console.log(colhead);
    for (const r of rows) {
      console.log('  ' + r.key.padEnd(9) + OFFS.map((o) => { const s = cells.filter((c) => r.test(c) && c.off === o); return f1(pct(s.filter((c) => c.stopped).length, s.length)).padStart(8); }).join(''));
    }
    console.log('   → best entry per row (max avg PnL%):');
    for (const r of rows) {
      const b = OFFS.map((o) => { const s = cells.filter((c) => r.test(c) && c.off === o); return { o, v: mean(s.map((c) => c.pnl)), n: s.length, st: pct(s.filter((c) => c.stopped).length, s.length), w: pct(s.filter((c) => c.win).length, s.length) }; }).sort((a, b) => b.v - a.v)[0];
      console.log(`     ${r.key.padEnd(8)} ${label(b.o)} IST → avgPnL ${(b.v >= 0 ? '+' : '') + f1(b.v)}%, win ${f1(b.w)}%, stop ${f1(b.st)}% (n=${b.n})`);
    }
  };
  render('6b) NY ENTRY-TIME × WEEK-OF-MONTH', [1, 2, 3, 4, 5].map((w) => ({ key: 'W' + w, test: (c: C) => c.wom === w })));
  render('6c) NY ENTRY-TIME × MONTH', [...new Set(cells.map((c) => c.month))].sort().map((m) => ({ key: m, test: (c: C) => c.month === m })));
}

/** Outcome bucketed by entry ATM-IV level (absolute %) and by IV percentile. NY IV-turn entry, weekdays. */
function ivLevelAnalysis(cfg: SimConfig) {
  const data = loadData();
  interface T { iv0: number; dow: number; day: string; pnl: number; stopped: boolean; label: 'CRUSH' | 'REBOUND' | 'NO-EVENT'; }
  const trades: T[] = [];
  const [nySh, nyEh] = SESSIONS.NY;
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + nySh * HR, nyEnd = f.D0 + nyEh * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0);
    if (entryT == null) continue;
    const sim = simulateStrangle(data, f, entryT, cfg);
    if (!sim.ok) continue;
    const hold = classifyCrush(data.ivWindow(f.n2n, entryT, f.exit), entryT, entryT + 30 * MIN, f.exit);
    trades.push({ iv0: sim.iv0, dow: f.dow, day, pnl: sim.pnlPctMargin, stopped: sim.stopped, label: hold.label === 'NO-EVENT' ? (sim.stopped ? 'REBOUND' : 'CRUSH') : hold.label });
  }

  const summ2 = (xs: T[]) => ({
    n: xs.length, avgIV: mean(xs.map((x) => x.iv0)),
    stop: pct(xs.filter((x) => x.stopped).length, xs.length),
    win: pct(xs.filter((x) => x.pnl > 0).length, xs.length),
    kept: pct(xs.filter((x) => x.label === 'CRUSH').length, xs.length),
    bnc: pct(xs.filter((x) => x.label === 'REBOUND').length, xs.length),
    sl: mean(xs.filter((x) => x.stopped).map((x) => x.pnl)),
    pnl: mean(xs.map((x) => x.pnl)),
  });
  const printRow = (lab: string, s: ReturnType<typeof summ2>) => console.log(
    `  ${lab.padEnd(14)} ${String(s.n).padStart(3)}  ${f1(s.avgIV).padStart(5)}  ${f1(s.stop).padStart(5)}  ${f1(s.win).padStart(5)}  ${f1(s.kept).padStart(5)}  ${f1(s.bnc).padStart(5)}  ${f1(s.sl).padStart(6)}  ${((s.pnl >= 0 ? '+' : '') + f1(s.pnl)).padStart(7)}`);
  const head = '  bucket          n   avgIV  Stop%  Win%  Kept%  Bncd%  avgSL%  avgPnL%';

  console.log(`\n7) BY ENTRY ATM-IV LEVEL (NY IV-turn entry, weekday nights, n=${trades.length}):`);
  // Entry-IV extremes (lowest & highest IV available at entry) + per-weekday spread.
  const byIv = [...trades].sort((a, b) => a.iv0 - b.iv0);
  const lo = byIv[0], hi = byIv[byIv.length - 1];
  console.log(`  Entry IV range: LOW ${f1(lo.iv0)}% (${lo.day}, ${DOW[lo.dow]})  →  HIGH ${f1(hi.iv0)}% (${hi.day}, ${DOW[hi.dow]})`);
  console.log('  Entry IV by weekday (min / avg / max):');
  for (let d = 1; d <= 5; d++) {
    const xs = trades.filter((t) => t.dow === d).map((t) => t.iv0);
    if (xs.length) console.log(`     ${DOW[d]}: min ${f1(Math.min(...xs))}  avg ${f1(mean(xs))}  max ${f1(Math.max(...xs))}  (n=${xs.length})`);
  }
  console.log('\n  7a) Each 5-pt ATM-IV band across the FULL observed range (lowest → highest at entry):');
  console.log(head);
  const floor = Math.floor(lo.iv0 / 5) * 5, ceil = Math.ceil(hi.iv0 / 5) * 5;
  for (let b = floor; b < ceil; b += 5) { const xs = trades.filter((t) => t.iv0 >= b && t.iv0 < b + 5); if (xs.length) printRow(`${b}-${b + 5}`, summ2(xs)); }

  console.log('\n  7b) ATM IV percentile at entry (rank of entry IV within the year of entries):');
  console.log(head);
  const sorted = [...trades].sort((a, b) => a.iv0 - b.iv0);
  const rank = new Map<T, number>();
  sorted.forEach((t, i) => rank.set(t, (i / Math.max(1, sorted.length - 1)) * 100));
  const qs: [string, (p: number) => boolean][] = [
    ['p0-20 (low)', (p) => p < 20], ['p20-40', (p) => p >= 20 && p < 40], ['p40-60 (mid)', (p) => p >= 40 && p < 60],
    ['p60-80', (p) => p >= 60 && p < 80], ['p80-100 (high)', (p) => p >= 80],
  ];
  for (const [lab, test] of qs) { const xs = trades.filter((t) => test(rank.get(t)!)); if (xs.length) printRow(lab, summ2(xs)); }
}

function main() {
  const recs = run(DEFAULT_SIM); // base: 0.15Δ symmetric
  const bySess = (s: string) => recs.filter((r) => r.session === s);
  const ny = bySess('NY');

  console.log('='.repeat(100));
  console.log('IV-FALL TIMING & REAL-vs-FAKE FEAR — short strangle, N2N expiry, 0.15Δ, sell-on-IV-turn → 07:00 IST exit, 2× stop');
  console.log(`Span ${FIRST} → ${LAST}. Kept%(safe)=IV kept falling (your "fake fear", WIN). Bncd%(trap)=IV bounced back (your "real fear").`);
  console.log('='.repeat(100));

  console.log('\n1) BY SESSION — "if you sold when IV turned down in this session, held to 07:00 IST":');
  header('session');
  for (const s of ['Asia', 'London', 'NY']) row(s, summ(bySess(s)));

  console.log('\n2) BY DAY-OF-WEEK (NY-session strategy — your actual trade; Sat/Sun shown but you skip them):');
  header('weekday');
  for (let d = 1; d <= 6; d++) row(DOW[d], summ(ny.filter((r) => r.dow === d)));
  row(DOW[0], summ(ny.filter((r) => r.dow === 0)), '← SKIP (Sun night)');
  // Re-print Sat with skip tag for clarity
  console.log('  (Sat/Sun are your no-trade nights — shown to justify skipping them.)');

  console.log('\n3) BY WEEK-OF-MONTH (NY strategy):');
  header('week');
  for (let w = 1; w <= 5; w++) { const g = ny.filter((r) => r.wom === w); if (g.length) row('W' + w, summ(g)); }

  console.log('\n4) BY MONTH (NY strategy):');
  header('month');
  for (const m of [...new Set(ny.map((r) => r.month))].sort()) row(m, summ(ny.filter((r) => r.month === m)));

  // Delta sensitivity on the NY strategy (weekdays only, per the user's no-weekend rule).
  console.log('\n5) DELTA SENSITIVITY (NY strategy, weekday nights only):');
  console.log('  delta    n    Stop%   Win%   avgPnL%   avgSL%');
  for (const dl of [0.1, 0.125, 0.15]) {
    const r = run({ ...DEFAULT_SIM, deltaCall: dl, deltaPut: dl }).filter((x) => x.session === 'NY' && x.dow >= 1 && x.dow <= 5 && x.entered);
    const st = r.filter((x) => x.stopped);
    console.log(`  ${dl.toFixed(3)}  ${String(r.length).padStart(3)}  ${f1(pct(st.length, r.length)).padStart(5)}  ${f1(pct(r.filter((x) => x.pnlPctMargin > 0).length, r.length)).padStart(5)}  ${f1(mean(r.map((x) => x.pnlPctMargin))).padStart(7)}  ${f1(mean(st.map((x) => x.pnlPctMargin))).padStart(6)}`);
  }

  nyHeatmap(DEFAULT_SIM);
  nyHeatmapExtra(DEFAULT_SIM);
  ivLevelAnalysis(DEFAULT_SIM);

  // Plain-language takeaways.
  console.log('\n' + '='.repeat(100));
  console.log('TAKEAWAYS:');
  const sessSumm = ['Asia', 'London', 'NY'].map((s) => ({ s, ...summ(bySess(s)) }));
  const bestSess = [...sessSumm].sort((a, b) => b.keptPct - a.keptPct)[0];
  const worstSess = [...sessSumm].sort((a, b) => b.bouncedPct - a.bouncedPct)[0];
  console.log(`  • IV most reliably KEEPS falling (safest to sell) in the ${bestSess.s} session (${f1(bestSess.keptPct)}% kept-falling, ${f1(bestSess.stopPct)}% stop).`);
  console.log(`  • IV most often TRAPS (falls then bounces) in the ${worstSess.s} session (${f1(worstSess.bouncedPct)}% bounced).`);
  const dowS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, ...summ(ny.filter((r) => r.dow === d)) })).filter((x) => x.n >= 3);
  const bestDay = [...dowS].sort((a, b) => b.keptPct - a.keptPct)[0];
  const worstDay = [...dowS].sort((a, b) => b.stopPct - a.stopPct)[0];
  if (bestDay) console.log(`  • Best weekday for a clean IV fall: ${DOW[bestDay.d]} (${f1(bestDay.keptPct)}% kept-falling, ${f1(bestDay.stopPct)}% stop).`);
  if (worstDay) console.log(`  • Worst weekday (IV struggles to fall / most traps): ${DOW[worstDay.d]} (${f1(worstDay.stopPct)}% stop, ${f1(worstDay.bouncedPct)}% bounced).`);
  const sat = summ(ny.filter((r) => r.dow === 6)); const sun = summ(ny.filter((r) => r.dow === 0));
  console.log(`  • Sat night: ${f1(sat.stopPct)}% stop / ${f1(sat.keptPct)}% kept-falling (n=${sat.n}). Sun night: ${f1(sun.stopPct)}% stop / ${f1(sun.keptPct)}% kept-falling (n=${sun.n}). → ${sat.stopPct > summ(ny.filter((r)=>r.dow>=1&&r.dow<=5)).stopPct || sun.stopPct > summ(ny.filter((r)=>r.dow>=1&&r.dow<=5)).stopPct ? 'skipping them looks justified.' : 'review whether skipping helps.'}`);
}

main();
