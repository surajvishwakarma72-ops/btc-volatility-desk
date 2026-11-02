/**
 * Short strangle Rule Book: the before-entry checklist (section 8.5), lot sizing (8.7) and the daily stop (8.4 rule 11).
 * Pure: the service gathers live readings, this decides. A reading that is missing counts as red ("no entry on NO DATA").
 */
import { RULEBOOK_CONFIG as CFG, type RulebookConfig } from './config.js';

export type Tick = true | false | null;
export type Group = 'Data' | 'News' | 'IV' | 'Trend' | 'Pulse' | 'Strikes' | 'Size' | 'Day';

export interface CheckItem {
  id: string;
  group: Group;
  label: string;
  /** true green, false red, null no data (treated as red). */
  ok: Tick;
  /** What the terminal sees now. */
  now: string;
  /** The rule this item enforces (shown when red). */
  rule: string;
}

export interface LegQuote { type: 'call' | 'put'; strike: number; delta: number; bid: number; ask: number }

export interface ChecklistInput {
  nowMs: number;
  /** Live market data loaded (option chain and spot). */
  marketOk: boolean;
  /** Regime inputs (hourly bars and DVOL) fresh. */
  regimeFresh: boolean;
  newsFeedDown: boolean;
  /** Latest CRITICAL/HIGH alert and how long its "no new entries" window lasts. */
  news: { level: 'CRITICAL' | 'HIGH' | null; until: number | null };
  /** Top-tier US releases (CPI, NFP, FOMC...) around now; null = calendar unknown. */
  releases: { title: string; atMs: number }[] | null;
  ivRv: number | null;
  adx: number | null;
  killer: boolean | null;
  pulseZone: 'sell' | 'caution' | 'avoid' | 'nodata' | null;
  /** The two short legs the strike picker would sell (N2N expiry); null when it could not plan them. */
  legs: LegQuote[] | null;
  /** Why the strike picker could not plan the legs (e.g. no strike near the target delta). */
  legsReason?: string | null;
  /** Account equity in USD as the user set it; null = not set. */
  equityUsd: number | null;
  /** Trades left at half size after a rule break. */
  halfSizeLeft: number;
  /** Today (IST): rule exits and realised loss. */
  day: { ruleExits: number; netPnlUsd: number; unlocked: boolean };
  /** Weekend or a top-tier release this week → the smaller risk band. */
  smallRiskDay: boolean;
  /** Month × week × day size multiplier from the calendar (section 9.11b); it replaces the weekend/event-week band. */
  calendarMult?: number | null;
  /** Compression / IV-regime / RV rows (lib/vol) and their size effect (0.5 = half). */
  volChecks?: { id: string; label: string; ok: boolean | null; now: string; rule: string }[] | null;
  volSizeMult?: number | null;
  /** Top-tier releases between entry and the expiry sold. */
  inPath?: { label: string; atMs: number }[] | null;
}

export interface Sizing {
  riskPct: number;
  /** USD lost per lot if the 1:1 exit fires, fees and slippage included. */
  lossPerLotUsd: number | null;
  lots: number | null;
  why: string;
}

export interface ChecklistResult {
  verdict: 'GO' | 'BLOCK';
  items: CheckItem[];
  red: CheckItem[];
  sizing: Sizing;
  dailyStop: { stopped: boolean; ruleExits: number; lossPct: number | null; why: string };
  /** Exit levels in BTC price: where each short strike sits. */
  exitLevels: { call: number | null; put: number | null };
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const istHm = (ms: number) => { const d = new Date(ms + 5.5 * 3_600_000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`; };

export function dailyStop(i: Pick<ChecklistInput, 'day' | 'equityUsd'>, cfg: RulebookConfig = CFG): ChecklistResult['dailyStop'] {
  const lossPct = i.equityUsd && i.equityUsd > 0 ? Math.max(0, -i.day.netPnlUsd) / i.equityUsd * 100 : null;
  const byExits = i.day.ruleExits >= cfg.dailyStopRuleExits;
  const byLoss = lossPct != null && lossPct >= cfg.dailyStopLossPct;
  const hit = byExits || byLoss;
  const why = byExits ? `${i.day.ruleExits} rule exits today (limit ${cfg.dailyStopRuleExits})`
    : byLoss ? `down ${fmt(lossPct!, 1)}% today (limit ${cfg.dailyStopLossPct}%)` : 'not reached';
  return { stopped: hit && !i.day.unlocked, ruleExits: i.day.ruleExits, lossPct, why: hit && i.day.unlocked ? `${why}; unlocked by you today` : why };
}

/** Lots = equity × risk ÷ loss per lot at the 1:1 exit (loss = the credit taken, plus fees and slippage). Rounded down. */
export function sizeTrade(i: Pick<ChecklistInput, 'legs' | 'equityUsd' | 'halfSizeLeft' | 'smallRiskDay' | 'calendarMult' | 'volSizeMult'>, cfg: RulebookConfig = CFG): Sizing {
  const cal = i.calendarMult != null && Number.isFinite(i.calendarMult);
  let riskPct = cal ? cfg.riskPct * i.calendarMult! : i.smallRiskDay ? cfg.riskPctSmall : cfg.riskPct;
  riskPct = Math.round(riskPct * 1000) / 1000;
  const notes = [cal ? `${riskPct}% (${cfg.riskPct}% × calendar ${i.calendarMult})` : i.smallRiskDay ? `${riskPct}% (weekend or event week)` : `${riskPct}% (normal day)`];
  if (i.volSizeMult != null && i.volSizeMult < 1) { riskPct = Math.round(riskPct * i.volSizeMult * 1000) / 1000; notes.push(`×${i.volSizeMult} for the volatility regime`); }
  if (i.halfSizeLeft > 0) { riskPct /= 2; notes.push(`halved: rule broken, ${i.halfSizeLeft} trade${i.halfSizeLeft === 1 ? '' : 's'} left at half size`); }
  if (!i.legs || i.legs.length !== 2) return { riskPct, lossPerLotUsd: null, lots: null, why: 'no strikes to size' };
  const creditPerLot = i.legs.reduce((s, l) => s + l.bid, 0) * cfg.contractBtc;
  const lossPerLotUsd = creditPerLot * (1 + cfg.slippagePct / 100) + cfg.feePerLotUsd * 4; // 2 legs in, 2 legs out
  if (!i.equityUsd || i.equityUsd <= 0) return { riskPct, lossPerLotUsd, lots: null, why: 'set your equity to size the trade' };
  const lots = Math.floor((i.equityUsd * riskPct / 100) / lossPerLotUsd);
  return { riskPct, lossPerLotUsd, lots, why: `${notes.join('; ')}; $${fmt(lossPerLotUsd)} at risk per lot` };
}

export function evaluateChecklist(i: ChecklistInput, cfg: RulebookConfig = CFG): ChecklistResult {
  const items: CheckItem[] = [];
  const add = (id: string, group: Group, label: string, ok: Tick, now: string, rule: string) => items.push({ id, group, label, ok, now, rule });

  // Data
  const dataOk = i.marketOk && i.regimeFresh && !i.newsFeedDown;
  add('data', 'Data', 'Feeds fresh', dataOk,
    dataOk ? 'market, regime and news feeds live' : [!i.marketOk && 'market data missing', !i.regimeFresh && 'regime data stale', i.newsFeedDown && 'news feed down'].filter(Boolean).join(', '),
    'No entry on NO DATA or a stale feed.');

  // News
  const newsBlocked = i.news.level != null && i.news.until != null && i.news.until > i.nowMs;
  add('news', 'News', 'No CRITICAL/HIGH news', !newsBlocked,
    newsBlocked ? `${i.news.level} alert: no new entries until ${istHm(i.news.until!)}` : 'none in the window', 'No entry for hours after a CRITICAL/HIGH alert.');

  if (i.releases == null) add('release', 'News', 'No top-tier release near', null, 'economic calendar unavailable', `No entry ${cfg.releaseBeforeMin} min before or ${cfg.releaseAfterMin} min after CPI/NFP/FOMC.`);
  else {
    const near = i.releases.find((r) => r.atMs - i.nowMs <= cfg.releaseBeforeMin * 60_000 && i.nowMs - r.atMs <= cfg.releaseAfterMin * 60_000);
    add('release', 'News', 'No top-tier release near', !near,
      near ? `${near.title} at ${istHm(near.atMs)}` : 'none within the window', `No entry ${cfg.releaseBeforeMin} min before or ${cfg.releaseAfterMin} min after CPI/NFP/FOMC.`);
  }

  // IV and trend
  add('ivrv', 'IV', `IV/RV > ${cfg.ivRvMin}`, i.ivRv == null ? null : i.ivRv > cfg.ivRvMin, i.ivRv == null ? 'no reading' : fmt(i.ivRv), 'Sell only when options price more movement than BTC delivers.');
  add('adx', 'Trend', `ADX < ${cfg.adxMax}`, i.adx == null ? null : i.adx < cfg.adxMax, i.adx == null ? 'no reading' : fmt(i.adx, 1), 'No entry into a trend.');
  add('killer', 'Trend', 'No killer pattern', i.killer == null ? null : !i.killer, i.killer == null ? 'no reading' : i.killer ? 'RVP and ADX rising together' : 'off', 'No entry when RVP and ADX rise together.');

  // Volatility regime, compression and RV (section 9.6a-9.8)
  for (const v of i.volChecks ?? []) add(v.id, v.id === 'compression' ? 'Trend' : 'IV', v.label, v.ok, v.now, v.rule);

  // Pulse
  const z = i.pulseZone;
  add('pulse', 'Pulse', 'Strangle Pulse: SELL', z == null || z === 'nodata' ? null : z === 'sell', z == null ? 'Pulse off' : z.toUpperCase(), 'Both gates: regime gate and Strangle Pulse SELL NOW.');

  // Strikes
  if (!i.legs || i.legs.length !== 2) {
    // the market is there but no strike sits in the band: that is a real red, not missing data
    const noStrike = i.marketOk && !!i.legsReason;
    add('delta', 'Strikes', `Both strikes ${cfg.deltaMin}–${cfg.deltaMax} delta`, noStrike ? false : null, i.legsReason || 'strike picker could not plan the N2N legs', 'Strikes only between 0.10 and 0.15 delta.');
    add('spread', 'Strikes', `Spreads < ${cfg.spreadMaxPct}% of premium`, null, 'no quotes', `No entry if either leg's spread > ${cfg.spreadMaxPct}% of its premium.`);
  } else {
    const ds = i.legs.map((l) => Math.abs(l.delta));
    const dOk = ds.every((d) => d >= cfg.deltaMin - 1e-9 && d <= cfg.deltaMax + 1e-9);
    add('delta', 'Strikes', `Both strikes ${cfg.deltaMin}–${cfg.deltaMax} delta`, dOk, i.legs.map((l) => `${l.type} ${l.strike} Δ${fmt(Math.abs(l.delta))}`).join(' · '), 'Strikes only between 0.10 and 0.15 delta.');
    const sp = i.legs.map((l) => { const mid = (l.bid + l.ask) / 2; return l.bid > 0 && l.ask >= l.bid && mid > 0 ? (l.ask - l.bid) / mid * 100 : null; });
    const spOk: Tick = sp.some((x) => x == null) ? null : sp.every((x) => x! <= cfg.spreadMaxPct);
    add('spread', 'Strikes', `Spreads < ${cfg.spreadMaxPct}% of premium`, spOk, i.legs.map((l, k) => `${l.type} ${sp[k] == null ? 'no quote' : `${fmt(sp[k]!, 1)}%`}`).join(' · '), `No entry if either leg's spread > ${cfg.spreadMaxPct}% of its premium.`);
  }

  // Size
  const sizing = sizeTrade(i, cfg);
  add('size', 'Size', `Risk ≤ ${sizing.riskPct}% of equity`, sizing.lots == null ? null : sizing.lots >= 1,
    sizing.lots == null ? sizing.why : sizing.lots >= 1 ? `${sizing.lots} lot${sizing.lots === 1 ? '' : 's'} (${sizing.why})` : 'less than 1 lot: the trade is too big for the account',
    'Risk per trade 1–2% of equity at the exit level; half on weekends, event weeks and after a rule break.');

  // Day
  const ds = dailyStop(i, cfg);
  if (i.calendarMult != null) add('calendar', 'Day', 'Calendar allows a trade', i.calendarMult >= 0.25, `month × week × day = ×${i.calendarMult}`, 'Calendar product under 0.25: too many risks stacked; skip.');
  if (i.inPath !== undefined) add('path', 'Day', 'No top-tier event before expiry', i.inPath == null ? null : i.inPath.length === 0,
    i.inPath == null ? 'calendar unavailable' : i.inPath.length ? i.inPath.map((e) => `${e.label} ${istHm(e.atMs)}`).join(', ') : 'none between entry and expiry',
    'Sell after a top-tier event, not before: no expiry that spans CPI/NFP/FOMC.');
  add('daily_stop', 'Day', 'Daily stop not reached', !ds.stopped, ds.why, `Daily stop: after ${cfg.dailyStopRuleExits} rule exits or a ${cfg.dailyStopLossPct}% equity loss in a day.`);

  const red = items.filter((x) => x.ok !== true);
  const call = i.legs?.find((l) => l.type === 'call')?.strike ?? null;
  const put = i.legs?.find((l) => l.type === 'put')?.strike ?? null;
  return { verdict: red.length ? 'BLOCK' : 'GO', items, red, sizing, dailyStop: ds, exitLevels: { call, put } };
}

/** Top-tier US releases from the ForexFactory feed rows (title, country, impact, date). */
const TOP_TIER = /\bcpi\b|consumer price|non-?farm|payrolls|fomc|federal funds|fed chair|powell|\bpce\b|core pce|interest rate decision/i;
export function topTierReleases(rows: readonly { title?: string; country?: string; impact?: string; date?: string }[]): { title: string; atMs: number }[] {
  return rows.filter((r) => (r.country ?? '').toUpperCase() === 'USD' && /high/i.test(r.impact ?? '') && TOP_TIER.test(r.title ?? ''))
    .map((r) => ({ title: String(r.title), atMs: Date.parse(r.date ?? '') }))
    .filter((r) => Number.isFinite(r.atMs));
}
