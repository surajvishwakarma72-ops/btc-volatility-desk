/**
 * Replay the bot's option strategies over the cached history (1m Binance candles + archived option
 * IV). Writes frontend/public/data/bot_replay.json for the Bot page.
 *
 *   npx tsx src/scripts/bot-replay.ts [fromDate] [toDate]
 *
 * The data caches (src/backtest/data/cache) are gitignored; regenerate them with `npm run bt:fetch`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../backtest/data/load.js';
import { buildAnalytics, type RunRecord } from '../lib/bot/analytics.js';
import { DEFAULT_FUTURES } from '../lib/bot/futures.js';
import { replayFutures } from '../lib/bot/futures-replay.js';
import { DEFAULT_REPLAY, replayAll, type ReplayData } from '../lib/bot/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../../frontend/public/data/bot_replay.json');

const d = loadData();
const bars = d.bars1m;
let lo = 0;

const data: ReplayData = {
  first: bars[0]!.t,
  last: bars[bars.length - 1]!.t,
  barsBetween(from, to) {
    let a = 0;
    let b = bars.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (bars[m]!.t < from) a = m + 1;
      else b = m;
    }
    const out = [];
    for (let i = a; i < bars.length && bars[i]!.t <= to; i++) out.push({ t: bars[i]!.t, h: bars[i]!.h, l: bars[i]!.l, c: bars[i]!.c });
    return out;
  },
  ivAt: (exp, t) => d.ivAt(new Date(exp).toISOString().slice(0, 10), t),
  dvolAt: (t) => d.dvolAt(t),
};
void lo;

const [fromDate, toDate] = process.argv.slice(2);
const t0 = Date.now();
const { runs, skipped, days } = replayAll(data, { fromDate, toDate });
console.log(`replayed ${days} days: ${runs.length} runs, ${skipped} skipped (no data/strikes) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const optionRecords: RunRecord[] = runs.map((r) => ({
  strategy: r.strategy,
  book: r.book,
  dateKey: r.dateKey,
  weekday: r.weekday,
  entryMs: r.entryMs,
  exitMs: r.exitMs,
  entryIv: r.entryIv,
  dvol: r.dvol,
  gateGo: r.gateGo,
  marginUsd: r.marginUsd,
  feesUsd: r.feesUsd,
  netPnl: r.netPnl,
  exitReason: r.exitReason,
  peakPnl: r.peakPnl,
  troughPnl: r.troughPnl,
  path: r.path,
}));

// Futures: same detectors, plan and exit stepping as the live paper engine, over the 1m candles.
const f0 = Date.now();
const fut = replayFutures(bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
console.log(`futures: ${fut.runs.length} trades from ${fut.signals} signals in ${((Date.now() - f0) / 1000).toFixed(1)}s; plan rejections: ${JSON.stringify(fut.skippedByPlan)}`);
const futuresRecords: RunRecord[] = fut.runs.map(({ dir: _d, lots: _l, leverage: _lv, entry: _e, exit: _x, stop: _s, target: _t, note: _n, confirmations: _c, grossPnl: _g, ...rec }) => rec);

const records: RunRecord[] = [...optionRecords, ...futuresRecords];
const analytics = buildAnalytics(records);
const out = {
  generatedAt: new Date().toISOString(),
  range: { from: runs[0]?.dateKey, to: runs[runs.length - 1]?.dateKey, days },
  config: DEFAULT_REPLAY,
  method:
    'Black-Scholes repricing from spot and archived ATM IV (no historical option quotes), 1.2% half-spread, Delta fee model, portfolio-margin approximation, same exit rules as the live paper engine.',
  // Variants evaluated here (for the multiple-testing log): 6 strategies x always/gated where applicable.
  trials: new Set(records.map((r) => `${r.strategy}|${r.book}`)).size,
  futuresConfig: DEFAULT_FUTURES,
  futuresNote:
    'Futures replay tests price-based confirmations only (wick, volume, RSI, VWAP and prior-day levels). Funding, open interest, liquidation and CVD crowding are layered on by the live engine but cannot be replayed because that history is not archived.',
  futuresPlanRejections: fut.skippedByPlan,
  futuresTrades: fut.runs.map((r) => ({ strategy: r.strategy, dateKey: r.dateKey, entryMs: r.entryMs, dir: r.dir, lots: r.lots, leverage: r.leverage, entry: r.entry, exit: r.exit, stop: r.stop, target: r.target, netPnl: r.netPnl, exitReason: r.exitReason, confirmations: r.confirmations, note: r.note })).slice(-400),
  analytics,
  runs: records.map(({ path: _p, ...rest }) => rest),
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const g of analytics.byStrategy) {
  console.log(
    `${g.key.padEnd(18)} n=${String(g.trades).padStart(3)} net=${g.netPnl.toFixed(0).padStart(6)} avg=${g.avgPnl.toFixed(2).padStart(7)} win=${(g.winRate * 100).toFixed(0)}% stop=${(g.stopRate * 100).toFixed(0)}% tp=${(g.tpRate * 100).toFixed(0)}% maxDD=${g.maxDrawdown.toFixed(0)}`,
  );
}
