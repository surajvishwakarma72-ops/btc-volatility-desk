/**
 * Calibration against the shadow dataset.
 *
 * Goals:
 *  (1) Validate the pricing/IV pipeline: my per-BTC credit ≈ shadow `cr` at the same
 *      entry (same BS, strikes, IV source) -> confirms faithfulness + the `cr` unit.
 *  (2) Confirm the $ scaling: position credit = credit × contractBTC (0.1) ≈ $30-35.
 *  (3) Quantify the stop-rule gap: shadow uses leg >= 2×TOTAL-credit (loose); we use the
 *      user's real rule leg >= 2×OWN-premium (strict). Report both SL rates.
 *  (4) Sweep the per-leg fee buffer and report avg net win / avg SL loss ($ & ₹) /
 *      expectancy / breakeven, so the fee can be anchored to the trader's real figures
 *      (avg win ≈ $10, avg SL ≈ ₹1000-1200).
 *
 * Run: npx tsx src/backtest/steps/calibrate.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHADOW = path.resolve(__dirname, '../../../../frontend/data/shadow_backtest_dataset.json');
const INR = 85;
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

function main() {
  const data = loadData();
  const shadow = JSON.parse(fs.readFileSync(SHADOW, 'utf-8'));
  const shadowByDay = new Map<string, any>();
  for (const s of shadow.sessions) shadowByDay.set(s.day, s);

  // Enumerate nights at the shadow's entry time: floor((open+180m)/HR)*HR.
  const matched: { day: string; dow: number; myCr: number; posCr: number; cr: number | null; myStop: boolean; shStop: boolean | null }[] = [];
  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (!data.hasIv(f.n2n)) continue;
    const entryT = Math.floor((f.open + 180 * MIN) / HR) * HR;
    if (f.exit > data.priceLast) continue;
    const r = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, feePerLegUsd: 0 });
    if (!r.ok) continue;
    const sh = shadowByDay.get(day);
    matched.push({
      day, dow: f.dow, myCr: r.credit, posCr: r.credit * DEFAULT_SIM.contractBTC,
      cr: sh ? sh.cr : null, myStop: r.stopped, shStop: sh ? sh.stoppedAt2x : null,
    });
  }

  // (1) credit pipeline validation (only where shadow has cr)
  const withCr = matched.filter((m) => m.cr != null && m.cr > 0);
  const ratios = withCr.map((m) => m.myCr / (m.cr as number));
  console.log('='.repeat(70));
  console.log(`CREDIT PIPELINE CHECK (n=${withCr.length} matched sessions)`);
  console.log(`  my per-BTC credit vs shadow cr — median ratio: ${median(ratios).toFixed(3)}  mean: ${mean(ratios).toFixed(3)}`);
  console.log(`  (ratio ~1.0 => pricing/IV pipeline matches the shadow generator)`);

  // (2) position credit $ scaling
  const posCr = matched.map((m) => m.posCr);
  console.log(`\nPOSITION CREDIT ($) = credit × contractBTC(${DEFAULT_SIM.contractBTC})`);
  console.log(`  median $${median(posCr).toFixed(2)}  mean $${mean(posCr).toFixed(2)}  (target: your real ~$30-35)`);

  // (3) stop-rule gap
  const bothKnown = matched.filter((m) => m.shStop != null);
  const myRate = (bothKnown.filter((m) => m.myStop).length / bothKnown.length) * 100;
  const shRate = (bothKnown.filter((m) => m.shStop).length / bothKnown.length) * 100;
  console.log(`\nSTOP-RULE GAP (n=${bothKnown.length}, entry ~21:30-22:00 IST)`);
  console.log(`  my rule (leg ≥ 2× OWN premium):   ${myRate.toFixed(1)}% stopped`);
  console.log(`  shadow rule (leg ≥ 2× TOTAL cr):  ${shRate.toFixed(1)}% stopped`);
  console.log(`  => shadow understates SL by ${(myRate - shRate).toFixed(1)} pts (looser rule).`);

  // (4) fee sweep
  console.log('\nFEE SWEEP (position-$ net economics at the shadow entry time):');
  console.log('  fee/leg   trades  SL%   win%   avgWin$  avgSL$   avgSL₹   exp/ trade$   breakeven%');
  const fees = [0, 0.5, 1, 1.5, 2, 2.5, 3];
  for (const fee of fees) {
    const pnls: number[] = [];
    const winP: number[] = [];
    const slP: number[] = [];
    let sl = 0;
    for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
      const day = dk(dayMs + 12 * HR);
      const f = frame(d0(day) + 20 * HR);
      if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
      if (f.dow === 0 || f.dow === 6) continue; // weekdays only for economics
      const entryT = Math.floor((f.open + 180 * MIN) / HR) * HR;
      const r = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, feePerLegUsd: fee });
      if (!r.ok) continue;
      pnls.push(r.pnlUsd);
      if (r.pnlUsd > 0) winP.push(r.pnlUsd);
      if (r.stopped) { slP.push(r.pnlUsd); sl++; }
    }
    const n = pnls.length;
    const avgWin = mean(winP);
    const avgSL = mean(slP);
    const breakeven = (Math.abs(avgSL) / (avgWin + Math.abs(avgSL))) * 100;
    console.log(
      `  $${fee.toFixed(2)}     ${String(n).padStart(5)}  ${((sl / n) * 100).toFixed(1).padStart(4)}  ${((winP.length / n) * 100).toFixed(1).padStart(5)}  ${avgWin.toFixed(2).padStart(7)}  ${avgSL.toFixed(2).padStart(6)}  ${Math.round(avgSL * INR).toString().padStart(6)}  ${mean(pnls).toFixed(2).padStart(10)}  ${breakeven.toFixed(1).padStart(9)}`,
    );
  }
  console.log('\nPick the fee row whose avgWin$ ≈ $10 and avgSL₹ ≈ -1000..-1200 to match your live figures.');
}

main();
