/**
 * Orchestrator — assembles the final machine-readable rulebook.json and a plain-language
 * REPORT.md from the Step 1-8 output JSONs. Run the steps first (or via `npm run bt:all`).
 *
 * Run: npx tsx src/backtest/run.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, 'output');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf-8'));

function main() {
  const step1 = read('step1_baseline.json');
  const step2 = read('step2_ivcrush.json');
  const step3 = read('step3_scorecard.json');
  const step4 = read('step4_vetoes.json');
  const step7 = read('step7_bestday.json');
  const step8 = read('step8_rulebook.json');

  const convByDow: Record<string, string> = {};
  for (const r of step7.rows) convByDow[r.dow] = r.conviction;

  const weekdayRules = step8.perDay.map((d: any) => ({
    weekday: d.dow,
    verdict: d.verdict, // TRADE | TRADE-LIGHT | SKIP
    oosWinPct: d.oosWin,
    expectancyUsd: d.expectancy,
    sampleSize: d.n,
    fragile: d.fragile,
    conviction: convByDow[d.dow] || 'NORMAL',
    earliest_entry: '22:30 IST',
    latest_entry: d.dow === 'Fri' ? '01:30 IST' : '01:00 IST',
  }));

  const rulebook = {
    generatedFrom: '2025-10-06..2026-10-17 (327 nights, Binance 15m/1m + archive IV, BS-repriced)',
    dataCaveats: [
      'Legs BS-repriced from ATM IV (no historical option prices/bid-ask).',
      'bid-ask>1.5% reject is live-only (not modeled).',
      'News blackout: no event calendar in data — high-SL months used as a proxy.',
      'vol-of-vol/skew/GEX/flow are sparse/low-fidelity and did not survive OOS.',
    ],
    global: {
      entry_window: 'Enter LATE, 22:30–01:00 IST (Fri to 01:30). Timing is the #1 stop-loss lever: SL falls from 50–75% at 19:00 to 10–25% by 23:00.',
      iv_conditions: ['IV>=35 filter did NOT reduce SLs (net-negative) — dropped.', 'Edge (IV-RV24) is structurally negative in BTC (~-7): the textbook IV>RV rule is dead.'],
      silence_conditions: ['Primary "silence" = the clock (late entry). Entry-time indicators barely separate SL vs non-SL nights (Step 3: all |d|<=0.24).'],
      veto_conditions: ['SKIP if rsi15 > 60 at entry — the ONLY entry veto that clears the 34.9% SL-precision breakeven and holds out-of-sample (SLs 65→42, net $221→$393).'],
      delay_rules: ['None — for rsi15>60 nights, SKIP beats DELAY (delaying to 01:00 still nets negative).'],
      leg_sizing: 'Symmetric 0.15Δ both legs. Asymmetric / further-OTM INCREASES stop-losses (cheaper legs double faster) — do not skew.',
      early_exit_rules: ['None — the 2.0× per-leg stop is optimal; 1.5×/1.75× stops cut too many near-miss winners (net $393→$164).'],
      news_blackout: ['Data-limited (no calendar). Proxy: highest-SL months were ' + step8.months.slice(0, 2).map((m: any) => `${m.m} (SL ${m.slRate}%)`).join(', ') + '.'],
      week_of_month: 'Week 1 is weakest (win 63.6%, exp $0.51); weeks 2–4 stronger (~71–75%).',
      position: '100 lots, net credit ~$30–35, margin ~$87, target net ≥10% margin (~$8.7), hard exit 07:00 IST.',
    },
    weekdays: weekdayRules,
    evidence: {
      blindBaselineBestPerWeekday: step1.bestPerWeekday,
      ivCrushCensus: step2.census,
      scorecardKept: step3.scorecard.filter((r: any) => r.verdict === 'CORE' || r.verdict === 'USEFUL').map((r: any) => r.name),
      vetoKept: step4.combo,
    },
  };

  fs.writeFileSync(path.join(OUT, 'rulebook.json'), JSON.stringify(rulebook, null, 2));

  const tradeDays = weekdayRules.filter((d: any) => d.verdict.startsWith('TRADE')).map((d: any) => d.weekday);
  const skipDays = weekdayRules.filter((d: any) => d.verdict === 'SKIP').map((d: any) => d.weekday);
  const report = `# BTC Short-Strangle — Stop-Loss Elimination: Findings

**Data:** ${rulebook.generatedFrom}

## Bottom line
Stop-losses are driven overwhelmingly by **entry timing and weekday**, not by entry-time
indicators. The blind strategy wins ~65% but stop-losses erase the edge; the levers that
actually cut SLs, in order of impact:

1. **Trade LATE (22:30–01:00 IST).** SL rate falls from 50–75% (19:00 NY open) to 10–25%
   (23:00+). This single change is the biggest stop-loss reducer.
2. **Skip RSI > 60 nights.** The only entry veto that survives out-of-sample
   (41.8% SL-precision > 34.9% breakeven): SLs 65→42, net roughly doubles.
3. **Pick the weekday.** OOS-validated: **TRADE ${tradeDays.join(', ') || '—'}**;
   **SKIP ${skipDays.join(', ') || '—'}** (Wed/Thu decayed out-of-sample despite strong
   in-sample numbers), weekends off.

## What does NOT work (myths tested and rejected)
- **Indicator filters** (Speed, VoV, IV-vs-Clock, Edge, ADX, DVOL, Range, IV level): at a
  fixed late entry they barely separate SL from non-SL nights (all effect sizes |d|≤0.24).
- **IV ≥ 35 / IV > RV edge:** net-negative; BTC's Edge is structurally ~−7 (IV below RV).
- **Asymmetric / further-OTM legs:** INCREASE stop-losses (cheaper legs hit 2× faster).
- **Tighter / early stops (1.5–1.75×):** cut too many near-miss winners; 2× is optimal.
- **Delaying vetoed nights** instead of skipping: still net-negative.

## The 2–3 "silence" signals you asked for
The honest answer: the dominant silence signal is **the clock** (late entry). The only
entry-time signal with any edge is **RSI ≤ 60** (avoid overbought-up setups). vol-of-vol
and Speed help *select when to enter* at earlier variable entries (Step 2: 36%→26% SL) but
add nothing at a fixed late entry.

## Conviction
- **HIGH:** Fri (81.8% win, +$3.48/trade, target in ~3.5h).
- **NORMAL:** Mon/Tue (positive but fragile).
- **SKIP:** Wed/Thu (OOS win < 65%), Week-1 of month, RSI>60 nights, weekends.

## Caveats
${rulebook.dataCaveats.map((c: string) => '- ' + c).join('\n')}

See \`rulebook.json\` for the machine-readable rules and \`step*.json\` for full tables.
`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), report);
  console.log('[run] wrote output/rulebook.json and output/REPORT.md');
  console.log(`[run] TRADE: ${tradeDays.join(', ')} | SKIP: ${skipDays.join(', ')}`);
}

main();
