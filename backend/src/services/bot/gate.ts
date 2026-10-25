import { deribitWorker } from '../deribit-flow-worker.js';
import { macroStressWorker } from '../macro-stress-worker.js';

/**
 * v1 GO/WAIT gate for the `gated` books, built only from data the backend already has:
 * Deribit DVOL level and the macro-stress zone. The full desk gate (speed, Risk-ADX, IV falling)
 * lives in the browser today and is ported in a later phase; every trade stores this verdict so
 * the analytics can compare gated vs always.
 */
export interface GateVerdict {
  version: 'v1';
  go: boolean;
  reasons: string[];
  dvol: number | null;
  macroZone: string;
  macroScore: number;
  nextEvent: string;
  eventInWindow: boolean;
}

export const DVOL_MAX = 65;

export function evaluateGate(dvolMax: number = DVOL_MAX): GateVerdict {
  const dvol = deribitWorker.currentDvol;
  const macro = macroStressWorker.getSnapshot();
  const reasons: string[] = [];
  if (dvol == null) reasons.push('DVOL unavailable');
  else if (dvol >= dvolMax) reasons.push(`DVOL ${dvol.toFixed(1)} >= ${dvolMax}`);
  if (macro.zone !== 'calm') reasons.push(`macro zone ${macro.zone}`);
  const eventInWindow = !!macro.nextEvent && !/^(No Tier-1|loading)/.test(macro.nextEvent);
  return {
    version: 'v1',
    go: reasons.length === 0,
    reasons,
    dvol,
    macroZone: macro.zone,
    macroScore: macro.score,
    nextEvent: macro.nextEvent,
    eventInWindow,
  };
}
