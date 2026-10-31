/** Time grid and expiry-slot helpers for Strangle Pulse. Pure. */
import { PULSE_CONFIG } from './config.js';

export type Slot = 'current' | 'next' | 'n2n';
export const SLOTS: readonly Slot[] = ['current', 'next', 'n2n'];

const HOUR_MS = 3_600_000;
const SNAPSHOT_MS = PULSE_CONFIG.snapshotMinutes * 60_000;

/** Floors a timestamp to the UTC hour (cohort slot start). */
export function cohortSlotMs(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

/** Floors a timestamp to the 15-minute snapshot grid. */
export function snapshotGridMs(nowMs: number): number {
  return Math.floor(nowMs / SNAPSHOT_MS) * SNAPSHOT_MS;
}

/** Maps the sorted expiry list to current / next / n2n (indexes 0, 1, 2). */
export function resolveSlots(expiries: readonly number[]): Partial<Record<Slot, number>> {
  const sorted = [...expiries].sort((a, b) => a - b);
  const out: Partial<Record<Slot, number>> = {};
  SLOTS.forEach((slot, i) => {
    if (sorted[i] !== undefined) out[slot] = sorted[i];
  });
  return out;
}
