/**
 * Strangle Pulse leading test: does the damage reading come before premium jumps? Pure and read-only.
 * "does not lead" is a valid, expected-possible answer. All thresholds are fixed here so they cannot be tuned afterwards.
 */
import { damageAt, type Entry, type MinuteRow } from './metrics/damage.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
/** A jump: combined premium up at least this share of the entry premium within JUMP_WINDOW_MIN. */
const JUMP_PCT_OF_ENTRY = 0.2;
const JUMP_WINDOW_MIN = 30;
/** Readings closer together than this are one episode. */
const EPISODE_GAP_MIN = 30;
/** Plain-BTC baseline: a reading is an absolute 5-minute futures move in the top 5% of all such moves. */
const BTC_WINDOW_MIN = 5;
const BTC_TOP_SHARE = 0.05;
const MIN_DAYS = 14;
const MIN_JUMPS = 20;
const EPS = 1e-9;

export interface SignalReport {
  /** Episodes: consecutive readings within 30 minutes count once. */
  readings: number;
  /** Episodes followed by a jump that starts strictly after the reading, within 5, 15 and 30 minutes. */
  hits: { m5: number; m15: number; m30: number };
  /** Median minutes from reading to the next jump start, over episodes hit within 30 minutes. */
  medianLeadMin: number | null;
  /** Episodes with no jump starting within 30 minutes, divided by episodes. */
  falseAlarmRate: number | null;
}
export interface LeadReport {
  days: number;
  jumps: number;
  damage: SignalReport;
  btc: SignalReport;
  verdict: 'not enough data' | 'leads' | 'does not lead';
}

const finite = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function groupByCohort(rows: readonly MinuteRow[]): Map<number, MinuteRow[]> {
  const g = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    const a = g.get(r.cohort_id);
    if (a) a.push(r); else g.set(r.cohort_id, [r]);
  }
  for (const a of g.values()) a.sort((x, y) => x.t - y.t);
  return g;
}

/**
 * Jump start times (ms) for one position. A crossing is a good row whose premium is at least 20% of entry
 * above the lowest premium in the 30 minutes before it; the jump starts at the latest row at that low.
 * Crossings within 30 minutes of the previous crossing belong to the same jump.
 */
function jumpStarts(series: readonly MinuteRow[], entry: Entry): number[] {
  const need = JUMP_PCT_OF_ENTRY * (entry.call + entry.put) - EPS;
  const pts = series
    .filter((r) => r.data_ok && finite(r.call_mid) && finite(r.put_mid))
    .map((r) => ({ t: r.t, p: (r.call_mid as number) + (r.put_mid as number) }));
  const starts: number[] = [];
  let lastCross = -Infinity;
  for (let k = 1; k < pts.length; k++) {
    let low: { t: number; p: number } | null = null;
    for (let j = k - 1; j >= 0 && pts[k]!.t - pts[j]!.t <= JUMP_WINDOW_MIN * MIN_MS; j--) {
      if (!low || pts[j]!.p < low.p) low = pts[j]!; // scanning back: ties keep the latest row
    }
    if (!low || pts[k]!.p - low.p < need) continue;
    if (pts[k]!.t - lastCross > JUMP_WINDOW_MIN * MIN_MS) starts.push(low.t);
    lastCross = pts[k]!.t;
  }
  return starts;
}

/** First reading of each run of readings spaced 30 minutes or less apart. */
function episodes(times: readonly number[]): number[] {
  const out: number[] = [];
  let prev = -Infinity;
  for (const t of times) {
    if (t - prev > EPISODE_GAP_MIN * MIN_MS) out.push(t);
    prev = t;
  }
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Score the episodes of one signal against jump starts. Only jumps beginning strictly after a reading count. */
function score(readingTimes: readonly { t: number; starts: readonly number[] }[]): SignalReport {
  const hits = { m5: 0, m15: 0, m30: 0 };
  const leads: number[] = [];
  let falseAlarms = 0;
  for (const { t, starts } of readingTimes) {
    const next = starts.find((s) => s > t);
    const lead = next === undefined ? Infinity : (next - t) / MIN_MS;
    if (lead <= 5) hits.m5++;
    if (lead <= 15) hits.m15++;
    if (lead <= 30) { hits.m30++; leads.push(lead); } else falseAlarms++;
  }
  const n = readingTimes.length;
  return { readings: n, hits, medianLeadMin: median(leads), falseAlarmRate: n ? falseAlarms / n : null };
}

export function leadReport(rows: readonly MinuteRow[], entries: ReadonlyMap<number, Entry>): LeadReport {
  const byCohort = groupByCohort(rows);

  // Plain-BTC baseline threshold from every 5-minute move in the data.
  const moves = new Map<MinuteRow, number>();
  for (const series of byCohort.values()) {
    const at = new Map<number, MinuteRow>();
    for (const r of series) if (r.data_ok && finite(r.fut_price) && r.fut_price > 0) at.set(r.t, r);
    for (const r of at.values()) {
      const past = at.get(r.t - BTC_WINDOW_MIN * MIN_MS);
      if (past) moves.set(r, Math.abs(((r.fut_price as number) - (past.fut_price as number)) / (past.fut_price as number)));
    }
  }
  const sorted = [...moves.values()].sort((a, b) => b - a);
  const cut = sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * BTC_TOP_SHARE) - 1)]! : Infinity;

  const dmg: { t: number; starts: number[] }[] = [];
  const btc: { t: number; starts: number[] }[] = [];
  let jumps = 0;
  for (const [id, series] of byCohort) {
    const entry = entries.get(id);
    if (!entry) continue;
    const starts = jumpStarts(series, entry);
    jumps += starts.length;
    const dTimes: number[] = [];
    const bTimes: number[] = [];
    for (const r of series) {
      const d = damageAt(r, series, entry);
      if (d && ((d.call?.score ?? 0) >= 100 || (d.put?.score ?? 0) >= 100)) dTimes.push(r.t);
      const m = moves.get(r);
      if (m !== undefined && m > 0 && m >= cut) bTimes.push(r.t);
    }
    for (const t of episodes(dTimes)) dmg.push({ t, starts });
    for (const t of episodes(bTimes)) btc.push({ t, starts });
  }

  const ts = rows.map((r) => r.t);
  const days = ts.length ? (Math.max(...ts) - Math.min(...ts)) / DAY_MS : 0;
  const damage = score(dmg);
  const plain = score(btc);

  let verdict: LeadReport['verdict'];
  if (days < MIN_DAYS || jumps < MIN_JUMPS) verdict = 'not enough data';
  else {
    const rate = (s: SignalReport) => (s.readings ? s.hits.m30 / s.readings : 0);
    const fa = (s: SignalReport) => s.falseAlarmRate ?? 0;
    verdict = damage.readings > 0 && rate(damage) > rate(plain) && fa(damage) <= fa(plain) ? 'leads' : 'does not lead';
  }
  return { days, jumps, damage, btc: plain, verdict };
}
