/** Which cohorts the minute recorder follows on a slot. Pure. */
import type { Slot } from './grid.js';
import type { PulseCohort } from './snapshot.js';
import { DAMAGE_CONFIG } from './config.js';

/**
 * The newest open strangle on the slot, and the one before it while the newest is under windowMin minutes old,
 * so a switch still has its five minute look-back. Futures-only and closed cohorts are never followed.
 */
export function minuteTargets(live: readonly PulseCohort[], slot: Slot, now: number): PulseCohort[] {
  const open = live.filter((c) => c.slot === slot && c.status === 'open').sort((a, b) => b.slot_ms - a.slot_ms);
  const [newest, previous] = open;
  if (!newest) return [];
  const out = [newest];
  if (previous && now - newest.opened_at < DAMAGE_CONFIG.windowMin * 60_000) out.push(previous);
  return out;
}
