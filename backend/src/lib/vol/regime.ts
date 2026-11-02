/**
 * Silence & compression (9.6a), IV regimes (9.7) and RV rules (9.8) from the build prompt. Pure: the service supplies
 * hourly BTC bars, daily closes and DVOL history; this decides. Every threshold lives in VOL_CONFIG.
 *
 * IV here is Deribit DVOL (the 30-day BTC index). Your short-dated OTM strikes trade at lower IV than DVOL, which is why
 * everything is a percentile of its own 12 months, never an absolute level.
 */
import { DAY, H, istDate, istKey, istMidnight } from '../calendar/time.js';
import { sessionsFor } from '../calendar/tonight.js';

export const VOL_CONFIG = {
  quietPct: 30,          // a session is quiet below this percentile of its own weekday baseline
  wavePct: 70,           // a wave is a session above this percentile
  baselineWeekdays: 60,
  coiledDays: 3,
  squeezeDays: 5,
  coiledIvRvMin: 1.3,
  coiledIvPctMin: 40,
  deadIvPct: 20,
  deadIvRv: 1.1,
  waveIvUpPts: 2.5,
  rolloverPts: 1.5,
  bands: [20, 40, 70, 90] as const, // Dead | Low | Core | Rich | Crisis
};

export interface Bar { t: number; o: number; h: number; l: number; c: number }
export interface IvPoint { t: number; v: number }

export type SessionName = 'Asia' | 'London' | 'NY';
export type Compression = 'Normal' | 'Quiet' | 'Coiled' | 'Squeeze';
export type Regime = 'Dead' | 'Low' | 'Core' | 'Rich' | 'Crisis';

// ---------- small maths ----------

export function percentileOf(x: number, sample: readonly number[]): number | null {
  const v = sample.filter(Number.isFinite);
  if (!v.length || !Number.isFinite(x)) return null;
  const below = v.filter((y) => y < x).length, equal = v.filter((y) => y === x).length;
  return ((below + equal / 2) / v.length) * 100;
}
export function quantile(sample: readonly number[], q: number): number | null {
  const v = sample.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
}
const logRet = (bars: readonly Bar[]) => bars.slice(1).map((b, i) => Math.log(b.c / bars[i]!.c));
/** Annualised realised vol (%) of hourly closes. */
export function rvHourly(bars: readonly Bar[]): number | null {
  const r = logRet(bars);
  if (r.length < 3) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 24 * 365) * 100;
}

// ---------- session ranges ----------

export interface SessionRange { dateKey: string; session: SessionName; weekday: number; rangePct: number; end: number }

/** High-low range (% of open) of each completed Asia / London / NY session, by IST date. */
export function sessionRanges(bars: readonly Bar[], nowMs: number): SessionRange[] {
  if (!bars.length) return [];
  const out: SessionRange[] = [];
  const first = bars[0]!.t, last = Math.min(nowMs, bars[bars.length - 1]!.t + H);
  // step through IST calendar days (noon IST of each), so the last day is never skipped whatever hour the history starts
  for (let day = istMidnight(first) + 12 * H; istMidnight(day) <= last; day += DAY) {
    const s = sessionsFor(day);
    const wins: [SessionName, number, number][] = [['Asia', s.asia[0], s.asia[1]], ['London', s.london[0], s.london[1]], ['NY', s.ny[0], s.ny[1]]];
    for (const [name, a, b] of wins) {
      if (b > last) continue; // not finished yet
      const inside = bars.filter((x) => x.t >= a && x.t + H <= b);
      if (inside.length < Math.floor((b - a) / H) - 1) continue; // gap in the data
      const hi = Math.max(...inside.map((x) => x.h)), lo = Math.min(...inside.map((x) => x.l));
      out.push({ dateKey: s.dateKey, session: name, weekday: istDate(day).wd, rangePct: ((hi - lo) / inside[0]!.o) * 100, end: b });
    }
  }
  return out;
}

const isWeekday = (wd: number) => wd >= 1 && wd <= 5;

export interface SessionSilence {
  session: SessionName;
  /** Consecutive quiet weekday sessions ending with the latest one (weekends never count, and never break the run). */
  quietRun: number;
  latest: { dateKey: string; rangePct: number; pct: number | null } | null;
  quietBelow: number | null;
  waveAbove: number | null;
  /** The last 5 weekday sessions, oldest first: true = quiet. */
  dots: boolean[];
}

export function silence(ranges: readonly SessionRange[], session: SessionName, cfg = VOL_CONFIG): SessionSilence {
  const wk = ranges.filter((r) => r.session === session && isWeekday(r.weekday)).sort((a, b) => a.end - b.end);
  const base = wk.slice(-cfg.baselineWeekdays).map((r) => r.rangePct);
  const quietBelow = quantile(base, cfg.quietPct / 100), waveAbove = quantile(base, cfg.wavePct / 100);
  let quietRun = 0;
  for (let i = wk.length - 1; i >= 0 && quietBelow != null; i--) { if (wk[i]!.rangePct < quietBelow) quietRun++; else break; }
  const last = wk.at(-1);
  return {
    session, quietRun, quietBelow, waveAbove,
    latest: last ? { dateKey: last.dateKey, rangePct: last.rangePct, pct: percentileOf(last.rangePct, base) } : null,
    dots: wk.slice(-5).map((r) => quietBelow != null && r.rangePct < quietBelow),
  };
}

// ---------- IV regime ----------

export function regimeOf(pct: number, cfg = VOL_CONFIG): Regime {
  const [a, b, c, d] = cfg.bands;
  return pct < a ? 'Dead' : pct < b ? 'Low' : pct < c ? 'Core' : pct < d ? 'Rich' : 'Crisis';
}

export const REGIME_RULE: Record<Regime, { rule: string; size: number }> = {
  Dead: { rule: 'No sale; wait for the wake-up wave', size: 0 },
  Low: { rule: 'Sell only on a wave roll-over, near 0.10 delta', size: 0.5 },
  Core: { rule: 'Full rule book', size: 1 },
  Rich: { rule: 'Sell only after the spike settles and IV starts falling', size: 0.5 },
  Crisis: { rule: 'No new strangles; manage or close existing ones', size: 0 },
};

// ---------- the full read ----------

export interface VolInput {
  nowMs: number;
  bars1h: Bar[];      // ~90 days
  closes1d: Bar[];    // ~1 year
  dvolDaily: IvPoint[]; // ~1 year
  dvolHourly: IvPoint[]; // last few days
  ivNow: number | null;
}

export interface VolRead {
  asOf: number;
  iv: { now: number | null; pct: number | null; pct24hAgo: number | null; regime: Regime | null; rule: string | null; low30: boolean | null; change24h: number | null };
  rv: { rv24: number | null; rv6: number | null; rv7d: number | null; ivRv: number | null; shortRising: boolean | null; band: string | null; bandRule: string | null };
  sessions: SessionSilence[];
  compression: { level: Compression; why: string; bbPct: number | null; rangeAt20dLow: boolean | null };
  deadIv: { dead: boolean | null; why: string };
  behaviour: { label: string; action: string } | null;
  wave: { step: 'Waiting' | 'Wave' | 'Settle' | 'Roll-over'; why: string; waveHigh: number | null };
  /** Effects on the before-entry checklist. */
  gate: { block: boolean; reasons: string[]; sizeMult: number; notes: string[] };
}

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;

export function readVol(i: VolInput, cfg = VOL_CONFIG): VolRead {
  const now = i.nowMs;
  // ---- IV ----
  const yearIv = i.dvolDaily.filter((p) => p.t > now - 365 * DAY).map((p) => p.v);
  const ivNow = i.ivNow ?? i.dvolHourly.at(-1)?.v ?? null;
  const pct = ivNow == null ? null : percentileOf(ivNow, yearIv);
  const iv24 = [...i.dvolHourly].reverse().find((p) => p.t <= now - 24 * H)?.v ?? null;
  const pct24 = iv24 == null ? null : percentileOf(iv24, yearIv);
  const month = i.dvolDaily.filter((p) => p.t > now - 30 * DAY).map((p) => p.v);
  const low30 = ivNow == null || !month.length ? null : ivNow <= Math.min(...month) + 0.25;
  const regime = pct == null ? null : regimeOf(pct, cfg);

  // ---- RV ----
  const h = i.bars1h.filter((b) => b.t + H <= now);
  const rv24 = rvHourly(h.slice(-25)), rv6 = rvHourly(h.slice(-7)), rv7d = rvHourly(h.slice(-24 * 7 - 1));
  const rv6prev = rvHourly(h.slice(-13, -6));
  const ivRv = ivNow != null && rv24 ? ivNow / rv24 : null;
  const shortRising = rv6 != null && rv7d != null && rv6prev != null ? rv6 > rv7d * 1.25 && rv6 > rv6prev : null;
  const band = ivRv == null ? null : ivRv < 1 ? '< 1.0' : ivRv < 1.3 ? '1.0–1.3' : ivRv <= 1.8 ? '1.3–1.8' : '> 1.8';
  const bandRule = ivRv == null ? null : ivRv < 1 ? 'Never sell' : ivRv < 1.3 ? 'Core regime only, half size' : ivRv <= 1.8 ? 'Normal' : 'Find the event; sell after it, or half size if none';

  // ---- sessions and compression ----
  const ranges = sessionRanges(h, now);
  const sessions = (['Asia', 'London', 'NY'] as SessionName[]).map((s) => silence(ranges, s, cfg));
  const maxRun = Math.max(0, ...sessions.map((s) => s.quietRun));
  // all three sessions quiet on the latest weekday
  const lastWeekday = [...ranges].filter((r) => isWeekday(r.weekday)).sort((a, b) => b.end - a.end)[0]?.dateKey;
  const allQuietDay = !!lastWeekday && sessions.every((s) => s.latest?.dateKey === lastWeekday && s.dots.at(-1) === true);
  const dailyRv = i.closes1d.slice(-366).map((_, k, arr) => (k < 20 ? null : rvDaily(arr.slice(k - 20, k + 1)))).filter((x): x is number => x != null);
  const rvNowD = dailyRv.at(-1) ?? null;
  const rvBottom20 = rvNowD != null ? (percentileOf(rvNowD, dailyRv) ?? 100) < 20 : false;
  const bb = bandwidthSeries(i.closes1d.slice(-386));
  const bbPct = bb.length ? percentileOf(bb.at(-1)!, bb) : null;
  const d1 = i.closes1d.filter((b) => b.t + DAY <= now);
  const ranges20 = d1.slice(-20).map((b) => (b.h - b.l) / b.o);
  const rangeAt20dLow = ranges20.length >= 20 ? ranges20.at(-1)! <= Math.min(...ranges20) : null;

  let level: Compression = 'Normal', why = 'sessions within their normal range';
  if (maxRun >= 1) { level = 'Quiet'; why = `${maxRun} quiet weekday session${maxRun === 1 ? '' : 's'} in a row`; }
  if (maxRun >= cfg.coiledDays || (allQuietDay && rvBottom20)) { level = 'Coiled'; why = maxRun >= cfg.coiledDays ? `${maxRun} quiet weekdays in a row (${sessions.find((s) => s.quietRun === maxRun)!.session})` : 'all three sessions quiet and daily RV in the bottom 20%'; }
  if (maxRun >= cfg.squeezeDays || (rangeAt20dLow && bbPct != null && bbPct < 10 && pct != null && pct < 20)) {
    level = 'Squeeze'; why = maxRun >= cfg.squeezeDays ? `${maxRun} quiet weekdays in a row` : 'daily range at a 20-day low, Bollinger width in the bottom 10% of the year, IV percentile under 20';
  }

  // ---- dead IV ----
  const deadWhy: string[] = [];
  if (pct != null && pct < cfg.deadIvPct) deadWhy.push(`IV percentile ${Math.round(pct)} < ${cfg.deadIvPct}`);
  if (low30) deadWhy.push('IV at its 30-day low');
  if (ivRv != null && ivRv < cfg.deadIvRv) deadWhy.push(`IV/RV ${ivRv.toFixed(2)} < ${cfg.deadIvRv}`);
  const deadKnown = pct != null || ivRv != null;
  const dead = deadKnown ? deadWhy.length > 0 : null;

  // ---- IV behaviour during silence ----
  const change24h = ivNow != null && iv24 != null ? ivNow - iv24 : null;
  let behaviour: VolRead['behaviour'] = null;
  if (level !== 'Normal' && ivRv != null) {
    if (change24h != null && change24h >= 2) behaviour = { label: 'Protection being bought', action: 'Don’t sell; tighten alerts on open trades' };
    else if (ivRv > 1.5) behaviour = { label: 'Market paying for an expected move', action: 'Check the nearest scheduled event; if none, overpaid: half size allowed' };
    else if (ivRv <= 1.2 && (pct ?? 100) < 40) behaviour = { label: 'Cheap premium', action: 'Don’t sell: wait' };
  }

  // ---- wake-up wave: wave → settle → roll-over ----
  const recent = ranges.filter((r) => r.end > now - 3 * DAY);
  const waveSess = [...recent].reverse().find((r) => { const s = sessions.find((x) => x.session === r.session)!; return s.waveAbove != null && r.rangePct > s.waveAbove; });
  let wave: VolRead['wave'] = { step: 'Waiting', why: 'no wave session in the last 3 days', waveHigh: null };
  if (waveSess) {
    const ivAtWave = [...i.dvolHourly].reverse().find((p) => p.t <= waveSess.end - 9 * H)?.v ?? null; // IV before the session
    const after = i.dvolHourly.filter((p) => p.t >= waveSess.end - 9 * H);
    const waveHigh = after.length ? Math.max(...after.map((p) => p.v)) : null;
    const ivUp = ivAtWave != null && waveHigh != null ? waveHigh - ivAtWave : null;
    if (ivUp != null && (ivUp >= cfg.waveIvUpPts || (pct ?? 0) > 40)) {
      const settled = rv6 != null && rv6prev != null && rv6 < rv6prev;
      if (!settled) wave = { step: 'Wave', why: `${waveSess.session} ${waveSess.dateKey} moved ${waveSess.rangePct.toFixed(1)}%, IV up ${ivUp.toFixed(1)} pts`, waveHigh };
      else if (ivNow != null && waveHigh != null && waveHigh - ivNow >= cfg.rolloverPts) wave = { step: 'Roll-over', why: `IV ${(waveHigh - ivNow).toFixed(1)} pts below its wave high: sellable IV, sell the fall`, waveHigh };
      else wave = { step: 'Settle', why: 'RV falling after the wave; waiting for IV to turn down from its high', waveHigh };
    } else wave = { step: 'Waiting', why: `${waveSess.session} moved but IV did not wake up`, waveHigh };
  }

  // ---- gate effects ----
  const reasons: string[] = [], notes: string[] = [];
  let sizeMult = 1;
  const half = (n: string) => { sizeMult = Math.min(sizeMult, 0.5); notes.push(n); };
  if (dead) reasons.push(`Dead IV: ${deadWhy.join(', ')}`);
  if (regime === 'Crisis') reasons.push('IV regime Crisis (> 90th percentile): no new strangles');
  if (regime === 'Dead') reasons.push('IV regime Dead (< 20th percentile)');
  if (regime === 'Low' && wave.step !== 'Roll-over') reasons.push('IV regime Low: sell only on a wave roll-over');
  if (regime === 'Low' || regime === 'Rich') half(`IV regime ${regime}: half size`);
  if (ivRv != null && ivRv < 1) reasons.push(`IV/RV ${ivRv.toFixed(2)} < 1.0: never sell`);
  if (ivRv != null && ivRv >= 1 && ivRv < 1.3) half('IV/RV 1.0–1.3: half size');
  if (shortRising) reasons.push('short-term RV rising faster than long-term: no new entries');
  if (level === 'Squeeze') reasons.push(`Squeeze (${why}): no new strangles until the break`);
  if (level === 'Coiled') {
    if (!(ivRv != null && ivRv >= cfg.coiledIvRvMin && pct != null && pct >= cfg.coiledIvPctMin)) reasons.push(`Coiled: needs IV/RV ≥ ${cfg.coiledIvRvMin} and IV percentile ≥ ${cfg.coiledIvPctMin}`);
    half('Coiled: half size, strikes near 0.10 delta');
  }
  if (behaviour && behaviour.label !== 'Market paying for an expected move') reasons.push(`${behaviour.label}: ${behaviour.action}`);

  return {
    asOf: now,
    iv: { now: ivNow, pct, pct24hAgo: pct24, regime, rule: regime ? REGIME_RULE[regime].rule : null, low30, change24h },
    rv: { rv24, rv6, rv7d, ivRv, shortRising, band, bandRule },
    sessions,
    compression: { level, why, bbPct, rangeAt20dLow },
    deadIv: { dead, why: deadWhy.length ? deadWhy.join(', ') : dead === false ? 'IV alive' : 'no IV reading' },
    behaviour, wave,
    gate: { block: reasons.length > 0, reasons, sizeMult, notes },
  };
}

export interface VolCheck { id: string; label: string; ok: boolean | null; now: string; rule: string }

/** The volatility rules as before-entry checklist rows (null = no reading, shown as red). */
export function volChecks(r: VolRead | null): VolCheck[] {
  if (!r) return [{ id: 'vol', label: 'Volatility history', ok: null, now: 'IV and price history unavailable', rule: 'No entry on NO DATA.' }];
  const f = (x: number | null, d = 0) => (x == null ? '—' : x.toFixed(d));
  const lowNeedsWave = r.iv.regime === 'Low' && r.wave.step !== 'Roll-over';
  const coiledBad = r.compression.level === 'Coiled' && r.gate.reasons.some((x) => x.startsWith('Coiled'));
  return [
    { id: 'dead_iv', label: 'IV not dead', ok: r.deadIv.dead == null ? null : !r.deadIv.dead, now: r.deadIv.why, rule: 'Dead IV (percentile < 20, 30-day low, or IV/RV < 1.1): no sale.' },
    { id: 'iv_regime', label: 'IV regime allows selling', ok: r.iv.regime == null ? null : !(r.iv.regime === 'Dead' || r.iv.regime === 'Crisis' || lowNeedsWave),
      now: r.iv.regime == null ? 'no IV history' : `${r.iv.regime} (IV ${f(r.iv.now, 1)}, percentile ${f(r.iv.pct)}): ${r.iv.rule}`, rule: 'Dead/Crisis: no new strangles. Low: only on a wave roll-over. Rich: only after the spike settles.' },
    { id: 'rv_trend', label: 'Short-term RV not rising', ok: r.rv.shortRising == null ? null : !r.rv.shortRising,
      now: `RV 6h ${f(r.rv.rv6)} · 24h ${f(r.rv.rv24)} · 7d ${f(r.rv.rv7d)}`, rule: 'Short-term RV rising faster than long-term: no new entries.' },
    { id: 'compression', label: 'Not in a squeeze', ok: !(r.compression.level === 'Squeeze' || coiledBad),
      now: `${r.compression.level}: ${r.compression.why}`, rule: 'Squeeze: no new strangles. Coiled: only with IV/RV ≥ 1.3 and IV percentile ≥ 40, half size.' },
    ...(r.behaviour && r.behaviour.label !== 'Market paying for an expected move'
      ? [{ id: 'iv_behaviour', label: 'IV behaviour during the silence', ok: false, now: r.behaviour.label, rule: r.behaviour.action }] : []),
  ];
}

function rvDaily(bars: readonly Bar[]): number | null {
  const r = logRet(bars);
  if (r.length < 5) return null;
  const m = mean(r);
  return Math.sqrt((r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * 365) * 100;
}
/** 20-day Bollinger bandwidth (4σ / mean) for each day with enough history. */
function bandwidthSeries(bars: readonly Bar[]): number[] {
  const out: number[] = [];
  for (let k = 19; k < bars.length; k++) {
    const w = bars.slice(k - 19, k + 1).map((b) => b.c), m = mean(w);
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    out.push((4 * sd) / m);
  }
  return out;
}

export { istKey };
