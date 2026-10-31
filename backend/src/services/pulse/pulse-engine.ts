import { randomUUID } from 'node:crypto';
import { closeNetPnl, buildSnapshot, type LegName, type PulseCohort } from '../../lib/pulse/snapshot.js';
import { planOpen, type OpenPlan } from '../../lib/pulse/cohort.js';
import { PULSE_CONFIG } from '../../lib/pulse/config.js';
import { SLOTS, cohortSlotMs, resolveSlots, snapshotGridMs, type Slot } from '../../lib/pulse/grid.js';
import {
  DEFAULT_OPTION_FEES, fetchChain, fetchOptionFeeRates, fetchPerpQuote, type ChainSnapshot, type FeeRates, type PerpQuote,
} from '../bot/delta-public.js';
import {
  closeCohorts, dbSizeBytes, ensurePulseSchema, gridIncomplete, hasCohort, insertCohort, insertSnapshot, lastLegSnapshots, latestGridMs,
  latestSeries, liveCohorts, logEvent, markStop,
} from './pulse-store.js';

const TICK_MS = 60_000;
const GRID_MS = PULSE_CONFIG.snapshotMinutes * 60_000;

export interface PulseStatus {
  enabled: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  dataOk: boolean;
  slots: Record<Slot, { expiryMs: number | null; live: number; seriesId: string | null }>;
  dbSizeBytes: number | null;
}

type Slots = Partial<Record<Slot, number>>;

const errText = (e: unknown): string => {
  const err = e as { message?: string; code?: string; name?: string } | null;
  return err?.message || err?.code || err?.name || String(e);
};

const zeroCounts = (): Record<Slot, number> => ({ current: 0, next: 0, n2n: 0 });

/** Why this chain and perp quote cannot be trusted, or null if they are fresh. */
function staleReason(chain: ChainSnapshot, perp: PerpQuote, nowMs: number): string | null {
  if (nowMs - perp.tsMs > PULSE_CONFIG.staleQuoteMs) return 'perp quote too old';
  const times = chain.options.flatMap((o) => (o.quoteTsMs === undefined ? [] : [o.quoteTsMs]));
  if (times.length === 0) return 'no option has a quote time';
  if (nowMs - Math.max(...times) > PULSE_CONFIG.staleQuoteMs) return 'chain quotes too old';
  return null;
}

/**
 * Strangle Pulse collector: opens one paper cohort per expiry slot each UTC hour and snapshots every live
 * cohort on the 15-minute grid. It reads public market data and writes only its own pulse_ tables, so nothing
 * here can reach the exchange's order API. The maths is pure (lib/pulse); this class schedules and persists.
 * State that matters is in the database; what is held in memory only removes repeated events.
 */
export class PulseEngine {
  lastTickAt: number | null = null;
  lastError: string | null = null;
  dataOk = false;
  private dbSize: number | null = null;

  private timer: NodeJS.Timeout | null = null;
  private alignTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private startTries = 0;
  /** Bumped by start and stop, so a start still awaiting the database can tell it was superseded. */
  private generation = 0;
  private busy = false;

  private lastGrid: number | null = null;
  private gapLoggedTo: number | null = null;
  private series: Partial<Record<Slot, string>> = {};
  /** The expiry each series belongs to. A slot whose expiry differs needs a new series. */
  private seriesExpiry: Slots = {};
  private slots: Slots = {};
  private live = zeroCounts();

  /** DATA_STALE and CHAIN_INCOMPLETE already logged in this outage. */
  private outageLogged = new Set<string>();
  private slotsLogged = new Set<Slot>();
  private missedLogged: Partial<Record<Slot, number>> = {};
  private dbSizeHour: number | null = null;

  get enabled(): boolean {
    return process.env.PULSE_ENABLED === 'true';
  }

  async start(): Promise<void> {
    if (!this.enabled || this.timer || this.alignTimer) return;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    const generation = ++this.generation;
    try {
      await ensurePulseSchema();
      await this.restore();
    } catch (e) {
      if (generation !== this.generation) return;
      // a database that is slow to answer must not leave the collector off for good: try again, a little later each time
      const wait = Math.min(60_000, 5_000 * 2 ** Math.min(this.startTries++, 4));
      this.lastError = `startup failed: ${errText(e)} (trying again in ${Math.round(wait / 1000)} s)`;
      console.error('[pulse]', this.lastError);
      this.startTimer = setTimeout(() => void this.start(), wait);
      this.startTimer.unref?.();
      return;
    }
    if (generation !== this.generation) return;
    this.startTries = 0;
    this.lastError = null;
    console.log('[pulse] collector started');
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null;
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref?.();
      void this.tick();
    }, TICK_MS - (Date.now() % TICK_MS));
    this.alignTimer.unref?.();
    await this.tick(); // a restart just inside the open grace must not wait out the minute
  }

  stop(): void {
    this.generation++;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.timer) clearInterval(this.timer);
    this.startTimer = this.alignTimer = this.timer = null;
  }

  status(): PulseStatus {
    const slot = (s: Slot) => ({ expiryMs: this.slots[s] ?? null, live: this.live[s], seriesId: this.series[s] ?? null });
    return {
      enabled: this.enabled,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      dataOk: this.dataOk,
      slots: { current: slot('current'), next: slot('next'), n2n: slot('n2n') },
      dbSizeBytes: this.dbSize,
    };
  }

  private async restore(): Promise<void> {
    const [grid, series, live] = await Promise.all([latestGridMs(), latestSeries(), liveCohorts()]);
    // max(grid_ms) is set by the first cohort written, so a crash part-way must not read as a finished grid.
    this.lastGrid = grid !== null && (await gridIncomplete(grid)) ? grid - GRID_MS : grid;
    this.series = series;
    // Only a live cohort proves a series still applies. Otherwise the slot rolled, or was never filled, so it starts a new one.
    this.seriesExpiry = {};
    for (const slot of SLOTS) {
      const cohort = live.find((c) => c.slot === slot && c.series_id === series[slot]);
      if (cohort) this.seriesExpiry[slot] = cohort.expiry_ms;
    }
    this.live = this.countLive(live);
  }

  private countLive(live: readonly PulseCohort[]): Record<Slot, number> {
    const counts = zeroCounts();
    for (const c of live) counts[c.slot]++;
    return counts;
  }

  /** One collector pass. Never throws: a failure is recorded and the next tick retries, because every write is idempotent. */
  async tick(nowMs = Date.now()): Promise<void> {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      await this.runTick(nowMs);
    } catch (e) {
      this.lastError = errText(e);
      console.error('[pulse] tick failed:', this.lastError);
    } finally {
      this.lastTickAt = nowMs;
      this.busy = false;
    }
  }

  private async runTick(now: number): Promise<void> {
    let chain: ChainSnapshot;
    let perp: PerpQuote;
    try {
      [chain, perp] = await Promise.all([fetchChain(now), fetchPerpQuote(PULSE_CONFIG.futuresSymbol)]);
    } catch (e) {
      return this.markUnhealthy('DATA_STALE', `market data stale: fetch failed: ${errText(e)}`, { reason: `fetch failed: ${errText(e)}` });
    }
    const stale = staleReason(chain, perp, now);
    if (stale) return this.markUnhealthy('DATA_STALE', `market data stale: ${stale}`, { reason: stale });

    // parseTicker drops bad tickers, so an expiry can vanish for a tick and shift every later slot into a false, irreversible roll.
    // A lapsed expiry fails the `> now` test, so the real 12:00 roll passes.
    const live = await liveCohorts();
    const missing = [...new Set(live.filter((c) => c.expiry_ms > now && !chain.expiries.includes(c.expiry_ms)).map((c) => c.expiry_ms))];
    if (missing.length > 0) return this.markUnhealthy('CHAIN_INCOMPLETE', `chain incomplete: ${missing.length} live expiry missing`, { missing });

    this.dataOk = true;
    this.outageLogged.clear();

    const slots = resolveSlots(chain.expiries);
    this.slots = slots;
    await this.logMissingSlots(slots, chain.expiries);

    const stillLive = await this.roll(now, live, slots, chain, perp);
    this.live = this.countLive(stillLive);
    this.rotateSeries(slots);
    await this.snapshot(now, stillLive, chain, perp);
    await this.open(now, slots, chain, perp);
    await this.logDbSize(now);
    this.lastError = null;
  }

  private async markUnhealthy(type: 'DATA_STALE' | 'CHAIN_INCOMPLETE', error: string, detail: unknown): Promise<void> {
    this.dataOk = false;
    this.lastError = error;
    if (this.outageLogged.has(type)) return;
    await logEvent(type, null, detail);
    this.outageLogged.add(type);
  }

  private async logMissingSlots(slots: Slots, expiries: readonly number[]): Promise<void> {
    for (const slot of SLOTS) {
      if (slots[slot] !== undefined) {
        this.slotsLogged.delete(slot);
      } else if (!this.slotsLogged.has(slot)) {
        await logEvent('SLOT_MISSING', slot, { expiries });
        this.slotsLogged.add(slot);
      }
    }
  }

  /** Closes cohorts that expired or whose slot moved to another expiry. Returns those still live. */
  private async roll(now: number, live: readonly PulseCohort[], slots: Slots, chain: ChainSnapshot, perp: PerpQuote): Promise<PulseCohort[]> {
    const stillLive: PulseCohort[] = [];
    for (const c of live) {
      const expired = c.expiry_ms <= now;
      const target = slots[c.slot];
      if (!expired && (target === undefined || target === c.expiry_ms)) {
        stillLive.push(c);
        continue;
      }
      const reason = expired ? 'EXPIRED' : 'ROLL';
      const last = reason === 'ROLL' ? await lastLegSnapshots(c.id) : {};
      await closeCohorts([c.id], reason, now, closeNetPnl(c, reason, chain.options, perp.spot, last));
    }
    return stillLive;
  }

  /** A series is one slot on one expiry, so this also covers rolls of a slot that had no live cohort to close. */
  private rotateSeries(slots: Slots): void {
    for (const slot of SLOTS) {
      const expiry = slots[slot];
      if (expiry === undefined || this.seriesExpiry[slot] === expiry) continue;
      this.series[slot] = randomUUID();
      this.seriesExpiry[slot] = expiry;
    }
  }

  private async snapshot(now: number, live: readonly PulseCohort[], chain: ChainSnapshot, perp: PerpQuote): Promise<void> {
    const grid = snapshotGridMs(now);
    if (grid === this.lastGrid) return;
    if (this.lastGrid !== null && grid - this.lastGrid > GRID_MS && this.gapLoggedTo !== grid) {
      await logEvent('SNAPSHOT_GAP', null, { from: this.lastGrid, to: grid });
      this.gapLoggedTo = grid;
    }
    for (const c of live) {
      if (c.slot_ms >= grid) continue; // a restart inside a cohort's opening grid: its first snapshot is the next grid
      const prev = await lastLegSnapshots(c.id);
      const built = buildSnapshot(c, chain.options, perp, prev, grid, now);
      try {
        for (const leg of ['call', 'put'] as const satisfies readonly LegName[]) {
          const stopAt = leg === 'call' ? c.call_sl_at : c.put_sl_at;
          if (!built.legs[leg].sl_hit || stopAt !== null) continue;
          const before = prev[leg];
          await markStop(c.id, leg, before?.sl_hit ? before.grid_ms : grid); // a healed stop keeps the grid that hit it
        }
      } finally {
        // Stored even if markStop failed: this row's sticky sl_hit is what lets a later tick recover the stop.
        await insertSnapshot(built);
      }
    }
    this.lastGrid = grid; // only now: a failed write above must leave this grid for the next tick to retry
  }

  private async open(now: number, slots: Slots, chain: ChainSnapshot, perp: PerpQuote): Promise<void> {
    const slotMs = cohortSlotMs(now);
    const late = now - slotMs > PULSE_CONFIG.lateOpenGraceMs;
    const due: Array<{ slot: Slot; expiryMs: number; plan: OpenPlan }> = [];
    for (const slot of SLOTS) {
      if (await hasCohort(slot, slotMs)) continue;
      if (late) {
        if (this.missedLogged[slot] === slotMs) continue;
        await logEvent('MISSED_OPEN', slot, { slotMs, expiryMs: slots[slot] ?? null });
        this.missedLogged[slot] = slotMs;
        continue;
      }
      const expiryMs = slots[slot];
      if (expiryMs !== undefined) due.push({ slot, expiryMs, plan: planOpen(chain.options, expiryMs) });
    }

    const symbols = due.flatMap(({ plan }) => (plan.kind === 'open' ? [plan.call.symbol, plan.put.symbol] : []));
    const fees = symbols.length > 0 ? await fetchOptionFeeRates(symbols) : new Map<string, FeeRates>();

    for (const { slot, expiryMs, plan } of due) {
      const base = {
        id: randomUUID(), slot, series_id: this.series[slot] as string, slot_ms: slotMs, expiry_ms: expiryMs, opened_at: now,
      };
      if (plan.kind === 'no_valid_strikes') {
        const stored = await insertCohort(this.noStrikesCohort(base, plan.missing));
        if (stored) await logEvent('NO_VALID_STRIKES', slot, { slotMs, expiryMs, missing: plan.missing });
        continue;
      }
      const { call, put } = plan;
      const stored = await insertCohort({
        ...base,
        status: 'open', closed_at: null, close_reason: null,
        spot_entry: perp.spot, fut_entry_bid: perp.bid, fut_entry_ask: perp.ask,
        call_symbol: call.symbol, put_symbol: put.symbol, call_strike: call.strike, put_strike: put.strike,
        call_bid: call.bid, put_bid: put.bid, call_mid: (call.bid + call.ask) / 2, put_mid: (put.bid + put.ask) / 2,
        call_delta: call.delta, put_delta: put.delta, call_theta: call.theta ?? null, put_theta: put.theta ?? null,
        call_iv: call.iv, put_iv: put.iv,
        fee: fees.get(call.symbol) ?? DEFAULT_OPTION_FEES, missing: null,
        call_sl_at: null, put_sl_at: null, net_pnl: null,
      });
      if (stored) this.live[slot]++;
    }
  }

  private noStrikesCohort(
    base: Pick<PulseCohort, 'id' | 'slot' | 'series_id' | 'slot_ms' | 'expiry_ms' | 'opened_at'>,
    missing: Array<'call' | 'put'>,
  ): PulseCohort {
    return {
      ...base,
      status: 'no_valid_strikes', closed_at: null, close_reason: null,
      spot_entry: null, fut_entry_bid: null, fut_entry_ask: null,
      call_symbol: null, put_symbol: null, call_strike: null, put_strike: null,
      call_bid: null, put_bid: null, call_mid: null, put_mid: null,
      call_delta: null, put_delta: null, call_theta: null, put_theta: null, call_iv: null, put_iv: null,
      fee: DEFAULT_OPTION_FEES, missing,
      call_sl_at: null, put_sl_at: null, net_pnl: null,
    };
  }

  private async logDbSize(now: number): Promise<void> {
    const hour = cohortSlotMs(now);
    if (hour === this.dbSizeHour) return;
    const bytes = await dbSizeBytes();
    await logEvent('DB_SIZE', null, { bytes });
    this.dbSize = bytes;
    this.dbSizeHour = hour;
  }
}

export const pulseEngine = new PulseEngine();
