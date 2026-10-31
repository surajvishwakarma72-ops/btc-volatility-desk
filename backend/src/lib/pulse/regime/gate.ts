import { REGIME_GATE_CONFIG } from '../config.js';
import { ivOverRv, type RegimeState } from './indicators.js';

export type InputId = 'iv_rv' | 'adx' | 'killer' | 'dvol' | 'events' | 'gex' | 'deribit_expiry';

export interface InputReading {
  id: InputId;
  label: string;
  value: number | boolean | string | null;
  threshold: string | null;
  tested: boolean;
  available: boolean;
  ok: boolean | null;
  note: string;
}

export interface GateInputs {
  nowMs: number;
  dvol: { value: number; at: number } | null;
  barsNewestOpenMs: number | null;
  state: RegimeState | null;
  rv24: number | null;
  macro: { hasData: boolean; status: 'ok' | 'degraded'; nextEvent: string } | null;
}

export interface RegimeGateResult {
  gateId: string;
  asOf: number;
  /** true: all tested inputs pass; false: any fails; null: none fails but some are unavailable. */
  pass: boolean | null;
  /** Macro event blackout (informational, not part of pass); null when macro data is unavailable. */
  blackout: boolean | null;
  reasons: string[];
  inputs: InputReading[];
}

const unavailable = (id: InputId, label: string, threshold: string | null, note: string, tested = true): InputReading => ({
  id, label, value: null, threshold, tested, available: false, ok: null, note,
});

const BARS_NOTE = 'hourly bars stale or missing';

export function evaluateRegimeGate(i: GateInputs, cfg: typeof REGIME_GATE_CONFIG = REGIME_GATE_CONFIG): RegimeGateResult {
  const barsFresh = i.barsNewestOpenMs != null && i.nowMs - i.barsNewestOpenMs <= cfg.barsMaxAgeMs;
  const dvolFresh = i.dvol != null && i.nowMs - i.dvol.at <= cfg.dvolMaxAgeMs;

  // IV/RV needs fresh bars (for RV) and a fresh DVOL (for IV).
  const ivRvLabel = 'IV/RV24';
  const ivRvThr = `> ${cfg.ivRvMin}`;
  let ivRv: InputReading;
  if (!barsFresh) ivRv = unavailable('iv_rv', ivRvLabel, ivRvThr, BARS_NOTE);
  else if (!dvolFresh || i.dvol == null) ivRv = unavailable('iv_rv', ivRvLabel, ivRvThr, 'DVOL unavailable');
  else {
    const ratio = ivOverRv((i.dvol.value * cfg.ivScaleK) / 100, i.rv24);
    if (ratio == null) ivRv = unavailable('iv_rv', ivRvLabel, ivRvThr, 'realised vol unavailable');
    else ivRv = { id: 'iv_rv', label: ivRvLabel, value: ratio, threshold: ivRvThr, tested: true, available: true, ok: ratio > cfg.ivRvMin, note: `IV/RV ${ratio.toFixed(2)}` };
  }

  let adx: InputReading;
  const adxThr = `< ${cfg.adxMax}`;
  if (!barsFresh) adx = unavailable('adx', 'ADX', adxThr, BARS_NOTE);
  else if (i.state?.adx == null) adx = unavailable('adx', 'ADX', adxThr, 'ADX not computable');
  else adx = { id: 'adx', label: 'ADX', value: i.state.adx, threshold: adxThr, tested: true, available: true, ok: i.state.adx < cfg.adxMax, note: `ADX ${i.state.adx.toFixed(1)}` };

  let killer: InputReading;
  if (!barsFresh) killer = unavailable('killer', 'Killer', 'not killer', BARS_NOTE);
  else if (i.state?.killer == null) killer = unavailable('killer', 'Killer', 'not killer', 'killer flag not computable');
  else killer = { id: 'killer', label: 'Killer', value: i.state.killer, threshold: 'not killer', tested: true, available: true, ok: !i.state.killer, note: i.state.killer ? 'ADX and RVP both rising' : 'not killer' };

  let dvol: InputReading;
  const dvolThr = `< ${cfg.dvolMax}`;
  if (i.dvol == null) dvol = unavailable('dvol', 'DVOL', dvolThr, 'DVOL missing');
  else if (!dvolFresh) dvol = unavailable('dvol', 'DVOL', dvolThr, 'DVOL older than 10 minutes');
  else dvol = { id: 'dvol', label: 'DVOL', value: i.dvol.value, threshold: dvolThr, tested: true, available: true, ok: i.dvol.value < cfg.dvolMax, note: `DVOL ${i.dvol.value.toFixed(1)}` };

  let events: InputReading;
  let blackout: boolean | null = null;
  if (i.macro && i.macro.hasData && i.macro.status === 'ok') {
    blackout = !/^(No Tier-1|loading)/.test(i.macro.nextEvent);
    events = { id: 'events', label: 'Macro events', value: i.macro.nextEvent, threshold: 'no Tier-1 event', tested: false, available: true, ok: !blackout, note: i.macro.nextEvent };
  } else {
    events = unavailable('events', 'Macro events', 'no Tier-1 event', 'macro calendar unavailable', false);
  }

  const gex = unavailable('gex', 'GEX', null, 'no data feed', false);
  const expiry = unavailable('deribit_expiry', 'Deribit expiry', null, 'no data feed', false);

  const inputs = [ivRv, adx, killer, dvol, events, gex, expiry];
  const tested = inputs.filter((x) => x.tested);
  const reasons: string[] = [];
  for (const x of tested) {
    if (!x.available) reasons.push(`${x.label} unavailable: ${x.note}`);
    else if (x.ok === false) {
      if (x.id === 'iv_rv') reasons.push(`IV/RV ${(x.value as number).toFixed(2)} is not above ${cfg.ivRvMin}`);
      else if (x.id === 'adx') reasons.push(`ADX ${(x.value as number).toFixed(1)} is not below ${cfg.adxMax}`);
      else if (x.id === 'dvol') reasons.push(`DVOL ${(x.value as number).toFixed(1)} is not below ${cfg.dvolMax}`);
      else reasons.push('Killer regime: ADX and RVP both rising');
    }
  }
  const pass = tested.some((x) => x.ok === false) ? false : tested.every((x) => x.ok === true) ? true : null;

  return { gateId: cfg.gateId, asOf: i.nowMs, pass, blackout, reasons, inputs };
}
