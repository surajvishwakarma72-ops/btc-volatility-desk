/** Strangle Pulse minute readings: one Risk, zone and lines point per minute from saved minute rows and the 15-minute points. Pure. */
import { DAMAGE_CONFIG, SCORE_CONFIG } from '../config.js';
import { damageAtIndexed, indexMinuteRows, triggerStep, type Entry, type MinuteRow, type SideDamage, type TriggerState } from '../metrics/damage.js';
import { lin, type Zone } from './score.js';

type N = number | null;
const MIN_MS = 60_000;
const HOLD_MS = 30 * MIN_MS;

/** One 15-minute point: c is confidence (Risk = 100 - c), null on a NO DATA point; z is its zone; call and put are the held risk lines. */
export interface BasePoint { t: number; c: N; z: Zone; call: N; put: N }
export interface MinutePoint {
  t: number;
  r: N;
  z: Zone;
  call: N;
  put: N;
  /** Long and short futures lines. */
  fl: N;
  fs: N;
  hurt: 'call' | 'put' | null;
  trigger: boolean;
}

const ok = (x: N | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
const round1 = (x: number): number => Math.round(x * 10) / 10;

function rawZone(r: number): Zone {
  const z = SCORE_CONFIG.zones;
  return r <= 100 - z.sellMin ? 'sell' : r <= 100 - z.cautionMin ? 'caution' : 'avoid';
}

const SAFEST_FIRST: readonly Zone[] = ['sell', 'caution', 'avoid'];

/** The minute zone, never safer than the held 15-minute zone. */
function clampToHeld(minute: Zone, held: Zone): Zone {
  return SAFEST_FIRST.indexOf(held) > SAFEST_FIRST.indexOf(minute) ? held : minute;
}

/** Signed move from a past price: `past` is the row nearest the futures window back, within one minute. Null when none. */
function futuresLines(price: N, past: N): { fl: N; fs: N } {
  if (!ok(price) || !ok(past)) return { fl: null, fs: null };
  const move = ((price - past) / past) * 100;
  const score = lin(Math.abs(move), DAMAGE_CONFIG.futuresMap) ?? 0;
  return { fl: move > 0 ? score : 0, fs: move < 0 ? score : 0 };
}

export function minuteReadings(rows: readonly MinuteRow[], entries: ReadonlyMap<number, Entry>, base: readonly BasePoint[]): MinutePoint[] {
  const byMinute = new Map<number, MinuteRow[]>();
  for (const r of rows) {
    const g = byMinute.get(r.t);
    if (g) g.push(r); else byMinute.set(r.t, [r]);
  }
  // Any futures price at each minute, newest cohort first.
  const futAt = new Map<number, N>();
  for (const [t, g] of byMinute) {
    const priced = [...g].sort((a, b) => b.cohort_id - a.cohort_id).find((r) => ok(r.fut_price));
    futAt.set(t, priced ? priced.fut_price : null);
  }
  const bases = [...base].sort((a, b) => a.t - b.t);
  const index = indexMinuteRows(rows);
  const times = [...byMinute.keys()].sort((a, b) => a - b);

  const out: MinutePoint[] = [];
  let trig: TriggerState = { above: 0, below: 0, on: false, side: null };
  let shown: Zone = 'nodata';
  let pending: Zone | null = null;
  let streak = 0;
  // Both only move forward, because the minutes are walked oldest first.
  let baseAt = -1;
  let futFrom = 0;

  for (const t of times) {
    const group = [...byMinute.get(t)!].sort((a, b) => b.cohort_id - a.cohort_id);
    let dmg: SideDamage | null = null;
    for (const r of group) {
      const e = entries.get(r.cohort_id);
      if (!e) continue;
      dmg = damageAtIndexed(r, index, e);
      if (dmg) break;
    }
    trig = triggerStep(trig, dmg);

    while (baseAt + 1 < bases.length && bases[baseAt + 1]!.t <= t) baseAt++;
    let held: BasePoint | null = baseAt >= 0 ? bases[baseAt]! : null;
    if (held && t - held.t > HOLD_MS) held = null;

    const target = t - DAMAGE_CONFIG.futuresWindowMin * MIN_MS;
    while (times[futFrom]! < target - MIN_MS) futFrom++;
    let pastPrice: N = null;
    let nearest = Infinity;
    for (let i = futFrom; i < times.length && times[i]! <= target + MIN_MS; i++) {
      const p = futAt.get(times[i]!);
      const d = Math.abs(times[i]! - target);
      if (d < nearest && ok(p) && p > 0) { pastPrice = p; nearest = d; }
    }
    const { fl, fs } = futuresLines(futAt.get(t) ?? null, pastPrice);
    const cs = dmg?.call?.score ?? null;
    const ps = dmg?.put?.score ?? null;
    const sides = [cs, ps].filter(ok);
    const worse = sides.length > 0 ? Math.max(...sides) : null;
    const hurt: 'call' | 'put' | null = worse !== null && worse > 0 ? (ok(cs) && cs >= (ps ?? -1) ? 'call' : 'put') : null;

    // A held NO DATA point is NO DATA here at once: the lane never shows safer than the card. The futures lines keep reading.
    if (!held || held.c === null || held.z === 'nodata') {
      shown = 'nodata'; pending = null; streak = 0;
      out.push({ t, r: null, z: 'nodata', call: null, put: null, fl, fs, hurt, trigger: trig.on });
      continue;
    }

    const mix = (s: N, line: N): N => (ok(s) && ok(line) ? round1(DAMAGE_CONFIG.lineDamageShare * s + (1 - DAMAGE_CONFIG.lineDamageShare) * line) : null);
    const heldRisk = 100 - held.c;
    const share = DAMAGE_CONFIG.weight / 100;
    const r = worse === null ? heldRisk : (1 - share) * heldRisk + share * worse;
    let raw = rawZone(r);
    if (worse === null && raw === 'sell') raw = 'caution';

    if (trig.on) { shown = 'avoid'; pending = null; streak = 0; }
    else if (shown === 'nodata' || raw === shown) { shown = raw; pending = null; streak = 0; }
    else {
      streak = pending === raw ? streak + 1 : 1;
      pending = raw;
      if (streak >= DAMAGE_CONFIG.zoneReadings) { shown = raw; pending = null; streak = 0; }
    }
    // No damage reading: never show SELL, even while a held zone change is pending.
    if (worse === null && shown === 'sell') { shown = 'caution'; pending = null; streak = 0; }
    out.push({ t, r: round1(r), z: clampToHeld(shown, held.z), call: mix(cs, held.call), put: mix(ps, held.put), fl, fs, hurt, trigger: trig.on });
  }
  return out;
}
