import { METRIC_CONFIG, PULSE_CONFIG, SCORE_CONFIG } from '../../lib/pulse/config.js';
import { cohortSlotMs, HOUR_MS, type Slot } from '../../lib/pulse/grid.js';
import { termInverted } from '../../lib/pulse/metrics/market.js';
import { pulseMomentum } from '../../lib/pulse/metrics/momentum.js';
import { metricSeries, winnerAtAge } from '../../lib/pulse/metrics/series.js';
import { breakevens, winnerPersistence } from '../../lib/pulse/metrics/tape.js';
import { linesAt, readings, type CohortSteps, type LiveContext } from '../../lib/pulse/score/score.js';
import type { PulseView } from '../../lib/algo/conditions.js';
import { regimeService } from './regime-service.js';
import { cohortRowsMany, latestMarketRows, pulseTablesExist, recentCohorts } from './pulse-store.js';

const speedsOf = (s: ReturnType<typeof metricSeries>[number] | undefined) => s && { deltaCall: s.delta_speed_call, deltaPut: s.delta_speed_put, gammaCall: s.gamma_speed_call, gammaPut: s.gamma_speed_put };
const nextSlotMs = (nowMs: number) => cohortSlotMs(nowMs) + HOUR_MS;

async function computeScore(slot: Slot) {
  const ready = await pulseTablesExist();
  const recent = ready ? await recentCohorts(slot, SCORE_CONFIG.historyHours + 12) : [];
  // Option cohorts feed the score steps; futures_only cohorts (no strike fit the delta band) only feed the futures reads and P&L.
  const traded = recent.filter((c) => c.status === 'open' || c.status === 'closed');
  const withFut = recent.filter((c) => c.status !== 'no_valid_strikes');
  const rowsBy = await cohortRowsMany(withFut.map((c) => c.id));
  const cohorts: CohortSteps[] = traded.map((c) => ({ opened_at: c.opened_at, steps: metricSeries(c, rowsBy.get(c.id) ?? []) }));
  // The direction lines also read futures-only cohorts (no strike fit the delta band that hour).
  const dirCohorts: CohortSteps[] = withFut.map((c) => ({ opened_at: c.opened_at, steps: metricSeries(c, rowsBy.get(c.id) ?? []) }));

  const nowMs = Date.now();
  // Futures-only hours count too, so the lane keeps walking when no strike fits; the Risk reading is NO DATA there, the futures lines are not.
  const grids = [...new Set(dirCohorts.flatMap((c) => c.steps.map((s) => s.grid_ms)))]
    .filter((g) => g >= nowMs - SCORE_CONFIG.historyHours * 3_600_000).sort((a, b) => a - b);

  const gate = regimeService.snapshot();
  const market = ready ? await latestMarketRows() : [];
  const fresh = market.length > 0 && nowMs - market[0].grid_ms <= METRIC_CONFIG.marketStaleMs;
  const atm = (s: Slot) => market.find((m) => m.slot === s)?.atm_iv ?? null;
  const scoredRecent = withFut.slice(0, METRIC_CONFIG.persistenceWindow);
  const winners = scoredRecent.flatMap((c) => { const j = winnerAtAge(c, rowsBy.get(c.id) ?? []); return j === null ? [] : [j.side]; });
  const live: LiveContext = {
    gatePass: gate.pass,
    killer: gate.inputs.find((i) => i.id === 'killer')?.ok === false ? true : null,
    termInverted: fresh ? termInverted(atm('current'), atm('next')) : null,
    persistence: winnerPersistence(winners),
    noValidStrikes: recent[0]?.status === 'no_valid_strikes' || recent[0]?.status === 'futures_only',
  };
  const list = readings(grids, cohorts, live);
  const last = list.at(-1) ?? null;

  const changes = list.flatMap((r, i) => (i > 0 && r.zone !== list[i - 1].zone ? [{ t: r.t, zone: r.zone, reason: r.why[0] ?? null }] : []));
  const open = traded.find((c) => c.status === 'open') ?? traded[0] ?? null;
  const pnlCohort = withFut.find((c) => c.status === 'open' || c.status === 'futures_only') ?? open;
  const credit = open && open.call_bid !== null && open.put_bid !== null ? open.call_bid + open.put_bid : null;
  const pnl = pnlCohort
    ? (rowsBy.get(pnlCohort.id) ?? []).filter((r) => r.data_ok).map((r) => ({
        t: r.sampled_ms, call: r.call.net_pnl, put: r.put.net_pnl, futLong: r.fut_long_pnl, futShort: r.fut_short_pnl,
        net: r.call.net_pnl === null || r.put.net_pnl === null ? null : r.call.net_pnl + r.put.net_pnl,
      }))
    : [];
  const points = list.map((r) => {
    const lo = linesAt(r.t, cohorts);
    const ld = linesAt(r.t, dirCohorts);
    return { t: r.t, c: r.confidence, z: r.zone, call: lo.call, put: lo.put, fl: ld.futLong, fs: ld.futShort };
  });
  const body = {
    success: true,
    slot,
    uncalibrated: true,
    card: last && {
      verdict: last.verdict, zone: last.zone, confidence: last.confidence, why: last.why, flips: last.flips, vetoes: last.vetoes, heavyLeg: last.heavyLeg,
      gate: { pass: gate.pass, reasons: gate.reasons },
      nextCohortMs: nextSlotMs(nowMs),
      speeds: speedsOf(cohorts.find((c) => c.opened_at === open?.opened_at)?.steps.at(-1)),
      strikes: open && { call: open.call_strike, put: open.put_strike, callDelta: open.call_delta, putDelta: open.put_delta },
      premium: open && { credit, breakevens: breakevens(open.call_strike, open.put_strike, credit) },
      stopPremium: open && { call: open.call_bid === null ? null : open.call_bid * PULSE_CONFIG.stopMultiple, put: open.put_bid === null ? null : open.put_bid * PULSE_CONFIG.stopMultiple },
    },
    zones: { sellMin: SCORE_CONFIG.zones.sellMin, cautionMin: SCORE_CONFIG.zones.cautionMin },
    points,
    // Display only: the verdict does not read this, it has not been backtested.
    momentum: pulseMomentum(withFut.map((c) => ({ opened_at: c.opened_at, rows: rowsBy.get(c.id) ?? [] })), {
      call: points.map((p) => p.call), put: points.map((p) => p.put), futLong: points.map((p) => p.fl), futShort: points.map((p) => p.fs),
    }),
    changes,
    pnl,
    cohort: pnlCohort && { id: pnlCohort.id, status: pnlCohort.status, opened_at: pnlCohort.opened_at },
  };
  return body;
}

const scoreCache = new Map<Slot, { at: number; body: Awaited<ReturnType<typeof computeScore>> }>();

/** The Strangle Pulse panel for one expiry slot, cached for 45 s. The lane and the algo condition share it, so they cannot disagree. */
export async function pulseScore(slot: Slot) {
  const hit = scoreCache.get(slot);
  if (hit && Date.now() - hit.at < 45_000) return hit.body;
  const body = await computeScore(slot);
  scoreCache.set(slot, { at: Date.now(), body });
  return body;
}

/** The newest reading for the algo's condition; null when there is none. */
export async function pulseNow(slot: Slot): Promise<PulseView | null> {
  const { card, points } = await pulseScore(slot);
  const last = points.at(-1);
  return card && last ? { zone: card.zone, risk: card.confidence === null ? null : 100 - card.confidence, t: last.t } : null;
}
