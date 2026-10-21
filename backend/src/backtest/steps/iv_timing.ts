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
