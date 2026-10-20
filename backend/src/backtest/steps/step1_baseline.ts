/**
 * STEP 1 — Blind baseline heatmap (weekday x entry-time).
 *
 * For every night in the dataset and every 15m entry from 19:00 IST (NY open) to
 * 01:30 IST (Mon-Thu) / 03:00 IST (Fri), with the fixed 2x SL / 10%-margin target /
 * 07:00 exit rules, aggregate per (weekday, entry-offset): trades, SL, target, time
 * exits, win%, avg net P&L ($ & ₹), avg & P95 MAE. Pick the best fixed time per weekday.
 *
 * Run: npx tsx src/backtest/steps/step1_baseline.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM, type SimResult } from '../lib/simulate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const INR = 85; // ₹ per $

const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[idx];
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

interface Cell {
  dow: number;
  offMin: number;
  res: SimResult[];
}

function main() {
  const data = loadData();
  console.log(`[step1] price ${new Date(data.priceFirst).toISOString()} → ${new Date(data.priceLast).toISOString()}`);

  const cells = new Map<string, Cell>();
  const addCell = (dow: number, offMin: number, r: SimResult) => {
    const k = `${dow}|${offMin}`;
    let c = cells.get(k);
    if (!c) { c = { dow, offMin, res: [] }; cells.set(k, c); }
    c.res.push(r);
  };

  let nights = 0;
  let start = d0(FIRST_DAY);
  const end = d0(LAST_DAY);
  for (let dayMs = start; dayMs <= end; dayMs += DAY) {
    const day = dk(dayMs + 12 * HR); // noon IST -> safe date string
    const f = frame(d0(day) + 20 * HR);
    if (!data.hasIv(f.n2n)) continue;
    if (data.ivAt(f.n2n, f.open) == null) continue;
    if (f.exit > data.priceLast || f.open < data.priceFirst) continue;

    const maxOff = f.dow === 5 ? 480 : 390; // Fri to 03:00 IST, else 01:30 IST
    let any = false;
    for (let off = 0; off <= maxOff; off += 15) {
      const r = simulateStrangle(data, f, f.open + off * MIN, DEFAULT_SIM);
      if (!r.ok) continue;
      addCell(f.dow, off, r);
      any = true;
    }
    if (any) nights++;
  }
  console.log(`[step1] simulated ${nights} nights, ${cells.size} (weekday×offset) cells`);

  // Aggregate each cell.
  const rows = [...cells.values()].map((c) => {
    const n = c.res.length;
    const sl = c.res.filter((r) => r.stopped).length;
    const tgt = c.res.filter((r) => r.outcome === 'TARGET').length;
    const timeWin = c.res.filter((r) => r.outcome === 'TIME-WIN').length;
    const wins = c.res.filter((r) => r.pnlUsd > 0).length;
    const pnls = c.res.map((r) => r.pnlUsd);
    const maes = c.res.map((r) => Math.abs(r.maeUsd));
    const avgPnl = mean(pnls);
    return {
      dow: c.dow,
      dowName: DOW_NAME[c.dow],
      offMin: c.offMin,
      entryIST: fmtIST(c.offMin),
      n,
      slRate: +((sl / n) * 100).toFixed(1),
      slCount: sl,
      targetRate: +((tgt / n) * 100).toFixed(1),
      timeWinRate: +((timeWin / n) * 100).toFixed(1),
      winRate: +((wins / n) * 100).toFixed(1),
      avgPnlUsd: +avgPnl.toFixed(2),
      avgPnlInr: Math.round(avgPnl * INR),
      avgMaeUsd: +mean(maes).toFixed(2),
      p95MaeUsd: +pct(maes, 95).toFixed(2),
    };
  }).sort((a, b) => a.dow - b.dow || a.offMin - b.offMin);

  // Best fixed entry per weekday by expectancy (avg net P&L), with SL rate.
  const best: Record<string, any> = {};
  for (let dow = 0; dow <= 6; dow++) {
    const dr = rows.filter((r) => r.dow === dow && r.n >= 10);
    if (!dr.length) continue;
    const top = dr.slice().sort((a, b) => b.avgPnlUsd - a.avgPnlUsd)[0];
    const leastSl = dr.slice().sort((a, b) => a.slRate - b.slRate)[0];
    best[DOW_NAME[dow]] = {
      bestByExpectancy: { entryIST: top.entryIST, avgPnlUsd: top.avgPnlUsd, slRate: top.slRate, winRate: top.winRate, n: top.n },
      leastStopLoss: { entryIST: leastSl.entryIST, slRate: leastSl.slRate, avgPnlUsd: leastSl.avgPnlUsd, n: leastSl.n },
    };
  }

  // Console heatmaps (win% and SL%) at hourly columns for readability.
  printHeatmap('WIN %', rows, (r) => r.winRate);
  printHeatmap('STOP-LOSS %', rows, (r) => r.slRate);
  printHeatmap('AVG NET P&L ($)', rows, (r) => r.avgPnlUsd);

  console.log('\nBest fixed entry per weekday (n>=10):');
  for (const [d, b] of Object.entries(best)) {
    console.log(`  ${d}: best P&L @ ${b.bestByExpectancy.entryIST} ($${b.bestByExpectancy.avgPnlUsd}, SL ${b.bestByExpectancy.slRate}%, win ${b.bestByExpectancy.winRate}%, n=${b.bestByExpectancy.n})  |  least-SL @ ${b.leastStopLoss.entryIST} (SL ${b.leastStopLoss.slRate}%, $${b.leastStopLoss.avgPnlUsd})`);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'step1_baseline.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedForDays: [FIRST_DAY, LAST_DAY], nights, config: DEFAULT_SIM, cells: rows, bestPerWeekday: best }, null, 2));
  console.log(`\n[step1] wrote ${outPath}`);
}

function fmtIST(offMin: number): string {
  // NY open = 19:00 IST; add offset.
  const total = 19 * 60 + offMin;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function printHeatmap(title: string, rows: any[], val: (r: any) => number) {
  console.log(`\n=== ${title} (rows=weekday, cols=entry IST, hourly) ===`);
  const offsets = [0, 60, 120, 180, 240, 300, 360, 420, 480];
  const header = ['Day '].concat(offsets.map((o) => fmtIST(o).padStart(6))).join(' ');
  console.log(header);
  for (let dow = 1; dow <= 5; dow++) {
    const line = [DOW_NAME[dow].padEnd(4)];
    for (const o of offsets) {
      const r = rows.find((x) => x.dow === dow && x.offMin === o);
      line.push((r ? String(val(r)) : '—').padStart(6));
    }
    console.log(line.join(' '));
  }
  for (const dow of [6, 0]) {
    const line = [(DOW_NAME[dow] + '*').padEnd(4)];
    for (const o of offsets) {
      const r = rows.find((x) => x.dow === dow && x.offMin === o);
      line.push((r ? String(val(r)) : '—').padStart(6));
    }
    console.log(line.join(' '));
  }
}

main();
