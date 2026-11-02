/** Strangle Pulse minute damage: premium rise on each sold leg against the BTC move, and the trigger built on it. Pure. */
import { DAMAGE_CONFIG } from '../config.js';

type N = number | null;
const MIN_MS = 60_000;

export interface MinuteRow {
  /** Minute timestamp in ms. */
  t: number;
  cohort_id: number;
  fut_price: N;
  call_mid: N;
  put_mid: N;
  call_iv: N;
  put_iv: N;
  data_ok: boolean;
}
export interface Entry { call: number; put: number }
export interface Side { premiumUpPct: number; ratio: number; score: number }
export interface SideDamage { call: Side | null; put: Side | null; movePct: number }
export interface TriggerState { above: number; below: number; on: boolean; side: 'call' | 'put' | null }

const ok = (x: N | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);

function lin(x: number, [bad, good]: readonly [number, number]): number {
  return Math.max(0, Math.min(100, ((x - bad) / (good - bad)) * 100));
}

function sideDamage(mid: N, mid5: N, entry: number, movePct: number): Side | null {
  if (!ok(mid) || !ok(mid5) || !ok(entry) || entry <= 0) return null;
  const premiumUpPct = Math.max(0, ((mid - mid5) / entry) * 100);
  const ratio = premiumUpPct / Math.max(Math.abs(movePct), DAMAGE_CONFIG.moveFloorPct);
  return { premiumUpPct, ratio, score: lin(ratio, DAMAGE_CONFIG.map) };
}

/** Damage over the last windowMin minutes, or null when no good same-cohort row sits that far back (one minute tolerance). */
export function damageAt(now: MinuteRow, rows: readonly MinuteRow[], entry: Entry): SideDamage | null {
  const target = now.t - DAMAGE_CONFIG.windowMin * MIN_MS;
  let past: MinuteRow | null = null;
  for (const r of rows) {
    if (r.cohort_id !== now.cohort_id || !r.data_ok || Math.abs(r.t - target) > MIN_MS) continue;
    if (!past || Math.abs(r.t - target) < Math.abs(past.t - target)) past = r;
  }
  if (!past || !now.data_ok) return null;
  const movePct = ok(now.fut_price) && ok(past.fut_price) && past.fut_price > 0 ? ((now.fut_price - past.fut_price) / past.fut_price) * 100 : 0;
  return {
    call: sideDamage(now.call_mid, past.call_mid, entry.call, movePct),
    put: sideDamage(now.put_mid, past.put_mid, entry.put, movePct),
    movePct,
  };
}

/** The side at full score with premium up enough, or null. When both qualify the larger ratio wins. */
function tripped(d: SideDamage | null): 'call' | 'put' | null {
  if (!d) return null;
  const hit = (s: Side | null) => s !== null && s.score >= 100 && s.premiumUpPct >= DAMAGE_CONFIG.triggerPremiumPct;
  const c = hit(d.call), p = hit(d.put);
  if (c && p) return d.call!.ratio >= d.put!.ratio ? 'call' : 'put';
  return c ? 'call' : p ? 'put' : null;
}

/** One minute step of the trigger: on after triggerMinutes steps at the levels, off after clearMinutes steps below. */
export function triggerStep(prev: TriggerState, d: SideDamage | null): TriggerState {
  const hit = tripped(d);
  if (hit) {
    const same = prev.above > 0 && prev.side === hit;
    const above = same ? prev.above + 1 : 1;
    const on = prev.on || above >= DAMAGE_CONFIG.triggerMinutes;
    return { above, below: 0, on, side: hit };
  }
  const below = prev.below + 1;
  if (prev.on && below < DAMAGE_CONFIG.clearMinutes) return { above: prev.above, below, on: true, side: prev.side };
  return { above: 0, below, on: false, side: null };
}
