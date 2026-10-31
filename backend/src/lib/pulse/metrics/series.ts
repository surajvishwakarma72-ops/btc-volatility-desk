/** Per-step metrics for one cohort, assembled from stored rows. Pure; a missing input or a zero divisor gives null. */
import { METRIC_CONFIG, PULSE_CONFIG } from '../config.js';
import type { LegRow, PulseCohort } from '../snapshot.js';
import { dsi, exitCostPct, liquidityBand, median, oiSignal, spreadPct, spreadVeto, type OiSignal } from './legs.js';
import { balanceDrift, decayEfficiency, expectedMove, heavyLeg, ivChange, rangeRatio } from './premium.js';
import { breakevens, efficiencyRatio, moveVsBreakeven } from './tape.js';

type N = number | null;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** One stored grid of a cohort: the cohort snapshot plus its two leg rows. */
export interface CohortRow {
  grid_ms: number;
  sampled_ms: number;
  spot: number;
  fut_price: number;
  net_delta: N;
  fut_long_pnl: N;
  fut_short_pnl: N;
  data_ok: boolean;
  call: LegRow;
  put: LegRow;
}

export interface StepMetrics {
  grid_ms: number;
  sampled_ms: number;
  minutes_since_entry: number;
  de_call: N;
  de_put: N;
  balance_drift: N;
  heavy_leg: 'call' | 'put' | null;
  dsi: N;
  net_delta: N;
  iv_call_since_entry: N;
  iv_put_since_entry: N;
  iv_call_1h: N;
  iv_put_1h: N;
  expected_move: N;
  range_ratio: N;
  oi_call: OiSignal;
  oi_put: OiSignal;
  spread_call: N;
  spread_put: N;
  spread_median_call: N;
  spread_median_put: N;
  spread_veto: boolean;
  exit_cost: N;
  liquidity: ReturnType<typeof liquidityBand>;
  move_vs_breakeven: N;
  efficiency_ratio: N;
  speed: Record<string, N>;
}

const SPEED_KEYS = [
  'de_call', 'de_put', 'balance_drift', 'dsi', 'net_delta', 'iv_call_since_entry', 'iv_put_since_entry', 'range_ratio',
  'exit_cost', 'spread_call', 'spread_put', 'move_vs_breakeven', 'efficiency_ratio',
] as const satisfies readonly (keyof StepMetrics)[];

const change = (now: N | undefined, base: N | undefined): N => (now == null || base == null ? null : now - base);
const sum = (a: N, b: N): N => (a === null || b === null ? null : a + b);
const mean = (a: N, b: N): N => (a === null || b === null ? null : (a + b) / 2);

/** Change per snapshot interval between two steps, over the time actually elapsed. */
function speeds(now: StepMetrics, prev: StepMetrics | undefined): Record<string, N> {
  const minutes = prev ? (now.sampled_ms - prev.sampled_ms) / MINUTE_MS : 0;
  const out: Record<string, N> = {};
  for (const k of SPEED_KEYS) {
    const delta = prev && minutes > 0 ? change(now[k], prev[k]) : null;
    out[k] = delta === null ? null : delta / (minutes / PULSE_CONFIG.snapshotMinutes);
  }
  return out;
}

/** One entry per data_ok row, oldest first. Rows must arrive oldest first. */
export function metricSeries(cohort: PulseCohort, rows: readonly CohortRow[]): StepMetrics[] {
  const good = rows.filter((r) => r.data_ok);
  const be = breakevens(cohort.call_strike, cohort.put_strike, sum(cohort.call_bid, cohort.put_bid));
  const futEntry = mean(cohort.fut_entry_bid, cohort.fut_entry_ask);
  const entryIv = mean(cohort.call_iv, cohort.put_iv);

  const spots: number[] = cohort.spot_entry === null ? [] : [cohort.spot_entry];
  const futPrices: number[] = [];
  const spreads: { sampled_ms: number; call: N; put: N }[] = [];
  const steps: StepMetrics[] = [];

  good.forEach((row, i) => {
    const prev: CohortRow | undefined = good[i - 1];
    const hourAgo: CohortRow | undefined = good[i - METRIC_CONFIG.lastHourSteps];
    const { call, put } = row;
    spots.push(row.spot);
    futPrices.push(row.fut_price);

    const elapsedDays = (row.sampled_ms - cohort.opened_at) / DAY_MS;
    const expected = expectedMove(cohort.spot_entry, entryIv, elapsedDays);

    const spreadCall = spreadPct(call.bid, call.ask, call.mid);
    const spreadPut = spreadPct(put.bid, put.ask, put.mid);
    spreads.push({ sampled_ms: row.sampled_ms, call: spreadCall, put: spreadPut });
    const lastDay = spreads.filter((s) => s.sampled_ms >= row.sampled_ms - DAY_MS);
    const medianOf = (which: 'call' | 'put') => median(lastDay.flatMap((s) => (s[which] === null ? [] : [s[which]])));
    const medianCall = medianOf('call');
    const medianPut = medianOf('put');

    const exitCost = exitCostPct(call.ask, put.ask, call.mid, put.mid, cohort.call_bid, cohort.put_bid);

    const step: StepMetrics = {
      grid_ms: row.grid_ms,
      sampled_ms: row.sampled_ms,
      minutes_since_entry: call.minutes_since_entry,
      de_call: decayEfficiency(cohort.call_mid, call.mid, cohort.call_theta, elapsedDays),
      de_put: decayEfficiency(cohort.put_mid, put.mid, cohort.put_theta, elapsedDays),
      balance_drift: balanceDrift(cohort.call_mid, cohort.put_mid, call.mid, put.mid),
      heavy_leg: heavyLeg(cohort.call_mid, cohort.put_mid, call.mid, put.mid),
      dsi: dsi(change(call.delta, prev?.call.delta), change(put.delta, prev?.put.delta), prev?.spot ?? null, row.spot),
      // A stored net delta is meaningless if a leg's delta was missing when it was written.
      net_delta: call.delta === null || put.delta === null ? null : row.net_delta,
      iv_call_since_entry: ivChange(call.iv, cohort.call_iv),
      iv_put_since_entry: ivChange(put.iv, cohort.put_iv),
      iv_call_1h: ivChange(call.iv, hourAgo?.call.iv ?? null),
      iv_put_1h: ivChange(put.iv, hourAgo?.put.iv ?? null),
      expected_move: expected,
      range_ratio: rangeRatio(spots, expected),
      oi_call: oiSignal(change(call.mid, prev ? prev.call.mid : cohort.call_mid), call.oi_change, call.volume_change),
      oi_put: oiSignal(change(put.mid, prev ? prev.put.mid : cohort.put_mid), put.oi_change, put.volume_change),
      spread_call: spreadCall,
      spread_put: spreadPut,
      spread_median_call: medianCall,
      spread_median_put: medianPut,
      spread_veto: spreadVeto(spreadCall, medianCall) || spreadVeto(spreadPut, medianPut),
      exit_cost: exitCost,
      liquidity: liquidityBand(exitCost),
      move_vs_breakeven: moveVsBreakeven(cohort.spot_entry, futPrices, futEntry, be),
      efficiency_ratio: futEntry === null ? null : efficiencyRatio([futEntry, ...futPrices]),
      speed: {},
    };
    step.speed = speeds(step, steps[i - 1]);
    steps.push(step);
  });
  return steps;
}
