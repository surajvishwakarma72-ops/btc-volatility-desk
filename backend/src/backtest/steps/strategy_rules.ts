/**
 * STRATEGY RULE ENGINE — the single declarative source of truth for the whole strategy.
 *
 * Everything we backtested lives here as DATA (not code), so:
 *   • the pictorial clock + whole-year calendar render from it,
 *   • a future rule-based algo calls the same planNight() decision,
 *   • you can add/change a rule by editing RULES — the UI + algo update automatically,
 *   • you can practice it MANUALLY from the per-day card this prints.
 *
 * Emits frontend/public/data/strategy_rules.js  →  window.__STRANGLE_RULES
 * Run: npx tsx src/backtest/steps/strategy_rules.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = {
  meta: { version: 1, updated: '2026-10-21', basis: '1-year NY short-strangle backtest (modeled, pre-friction)' },

  instrument: { product: 'BTC short strangle', expiry: 'N2N (3rd weekly)', delta: 0.15, legs: 'call + put' },
  session: 'New York',
  sizing: { baseLots: 100, rule: '100 lots WHEN the gate says GO. This is a conditions-based trade — not blind daily entry.' },

  // THE GATE — the whole point is to AVOID the stop. GO only when every condition holds; else WAIT.
  // Backtest (strict 2×, 1 yr): GO fires ~1 night in 3 → ~26% stop / ~73% win vs 33% stop trading every night.
  gate: {
    goal: 'Avoid the stop-loss. Trade the best setup, wait out the rest — never enter every day blindly.',
    conditions: [
      { id: 'turn', label: 'IV FALLING (the crush)', need: 'IV has peaked and turned DOWN ≥1pt — this is the real signal. Backtest: IV-fall predicts the win; premium richness does not. Even thin premium pays if IV crushes (your Fridays).' },
      { id: 'band', label: 'Not panic', need: 'ATM IV below 65. The 35–45 band IS traded (at a 3× stop), not skipped.' },
      { id: 'calm', label: 'Calm tape', need: 'Speed (RV÷IV) not in a storm — let a fast move exhaust first.' },
    ],
    waitReasons: ['IV not falling yet (wait for the turn)', 'IV ≥ 65 (panic)', 'price still fast (storm)'],
    result: 'All hold → SELL 100 lots. Backtest: ~26% stop, ~73% win, trades ~1 night in 3.',
  },

  entry: {
    trigger: 'ATM IV has peaked and turned DOWN ≥1pt in the NY session (sell the turn, never the spike)',
    windowIST: { default: [22.0, 23.5], friday: [23.0, 24.5] }, // Fri = premium, later entry
    neverBefore: 'the IV turn — entering at NY open (19:00) is the worst (−1% / 55% stop)',
  },
  exit: {
    profitTargetPctMargin: 12,     // let winners run; 5% caps them
    hardTimeIST: 7.0,              // 07:00 next morning
    stopMultiple: 2.0,             // STRICT 2× entry premium per leg — never wider
  },

  // Day rules. Sat/Sun off = the trader's own rule. Everything else trades.
  days: {
    Mon: { trade: true, note: 'normal' },
    Tue: { trade: true, note: 'normal (strongest early-week crush)' },
    Wed: { trade: true, note: 'normal' },
    Thu: { trade: true, note: 'normal' },
    Fri: { trade: true, premium: true, note: 'PREMIUM night (biggest weekend crush) — full size, enter ~23:00' },
    Sat: { trade: false, note: 'OFF (trader rule)' },
    Sun: { trade: false, note: 'OFF (trader rule) — worst night in the data anyway' },
  },

  // IV bands = ADVISORY confidence/size, NOT skip gates (except the emergency panic band).
  ivBands: [
    { lo: 0, hi: 25, label: 'thin', tone: 'amber', note: 'thin credit — trade, but expect more chop at 2×' },
    { lo: 25, hi: 35, label: 'calm', tone: 'green', note: 'calm & reliable — a 2× stop fits well (lowest stop band)' },
    { lo: 35, hi: 45, label: 'dead-zone', tone: 'amber', note: 'lowest edge — trade full size but lowest conviction' },
    { lo: 45, hi: 60, label: 'sweet', tone: 'green', note: 'the money zone — richest, cleanest crush' },
    { lo: 60, hi: 65, label: 'hot', tone: 'amber', note: 'elevated — trade with care' },
    { lo: 65, hi: 999, label: 'PANIC', tone: 'red', emergencySkip: true, note: 'real fear — the ONE band to sit out' },
  ],

  // Confidence indicators (advisory only — they colour the clock, they never block a trade).
  indicators: [
    { id: 'edge', name: 'Edge (IV − realised)', favour: 'HIGH', weight: 3, note: 'rich premium = being paid' },
    { id: 'iv', name: 'ATM IV level', favour: '45–60 band', weight: 3 },
    { id: 'vel', name: 'Price velocity 1h', favour: 'LOW', weight: 2, note: 'quiet tape' },
    { id: 'adx', name: 'ADX trend', favour: 'range-bound', weight: 2 },
    { id: 'term', name: 'Term spread', favour: 'watch (direction under review)', weight: 1 },
  ],

  // Session-event markers for the clock/journey (IST hours from local midnight).
  // Risk levels set by the session_events.ts realised-vol study (1-year): London close is the WILD one
  // (avg 51% RV, peaks Thu/Fri ~62%) and it sits right on your entry — the overnight hold is CALMER.
  events: [
    { id: 'londonClose', name: 'London close', ist: 21.5, risk: 'high', rvAvg: 51.3, note: "the night's wildest moment (peaks Thu/Fri) — do NOT sell into it; wait for it to exhaust (the IV turn)" },
    { id: 'cmeSettle', name: 'CME settle', ist: 25.5, risk: 'med', rvAvg: 37.0, note: 'inside the hold, but vol is already calming — hold, never add' },
    { id: 'nyClose', name: 'New York close', ist: 25.5, risk: 'med', rvAvg: 37.0, note: 'inside the hold; calmer than entry — stay in profit, never add' },
    { id: 'asiaOpen', name: 'Asia open', ist: 5.5, risk: 'low', rvAvg: 35.9, note: 'near your 07:00 exit; only Monday spikes (~54%)' },
  ],

  // Only-if-urgent skips. Nothing else is ever skipped.
  emergencySkipIf: ['ATM IV ≥ 65% (panic)', 'major scheduled high-impact event flagged red'],

  // When a stop happens, log the reason and the TIMING fix for next time (never "skip").
  autoImprove: { on: true, action: 'record stop reason (band / indicator / which session-event price-ran); adjust next same-day entry TIMING (enter later / after the event)' },
} as const;

type Dow = keyof typeof RULES.days;
function planNight(dow: Dow): string {
  const d = RULES.days[dow];
  if (!d.trade) return `${dow}:  REST — ${d.note}`;
  const w = (d as any).premium ? RULES.entry.windowIST.friday : RULES.entry.windowIST.default;
  const hm = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  return `${dow}:  TRADE — sell ${RULES.instrument.delta}Δ ${RULES.instrument.product} (${RULES.instrument.expiry}), ${RULES.sizing.baseLots} lots.
         Enter ${hm(w[0])}–${hm(w[1])} IST ON THE IV TURN · stop ${RULES.exit.stopMultiple}× · target ${RULES.exit.profitTargetPctMargin}% · exit ${hm(RULES.exit.hardTimeIST)} IST.${(d as any).premium ? '  ★ PREMIUM' : ''}`;
}

function main() {
  console.log('='.repeat(92));
  console.log('WEEKLY PRACTICE CARD — trade this by hand (every night unless emergency):');
  console.log('='.repeat(92));
  for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as Dow[]) console.log('  ' + planNight(dow));
  console.log('\n  IV read (advisory size/confidence, NOT skip):');
  for (const b of RULES.ivBands) console.log(`     ${String(b.lo).padStart(2)}–${b.hi === 999 ? '∞' : String(b.hi).padEnd(2)} ${b.label.padEnd(10)} [${b.tone}] ${b.note}${(b as any).emergencySkip ? '  ← the only sit-out' : ''}`);
  console.log('\n  Session events to respect on timing (don\'t open fresh into the high-risk ones):');
  const hm = (h: number) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
  for (const e of RULES.events) console.log(`     ${e.name.padEnd(14)} ~${hm(e.ist)} IST  [${e.risk}]${(e as any).note ? ' — ' + (e as any).note : ''}`);
  console.log(`\n  Emergency sit-out ONLY if: ${RULES.emergencySkipIf.join('  ·  ')}`);

  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'strategy_rules.js'), `window.__STRANGLE_RULES = ${JSON.stringify(RULES)};\n`);
  console.log(`\n[strategy_rules] wrote frontend/public/data/strategy_rules.js (window.__STRANGLE_RULES) — the clock + calendar + a future algo all read this.`);
}

main();
