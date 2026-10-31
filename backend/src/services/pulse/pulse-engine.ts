import { randomUUID } from 'node:crypto';
import { closeNetPnl, buildSnapshot, stopHitNow, type LegName, type PulseCohort } from '../../lib/pulse/snapshot.js';
import { feedFingerprint, finiteOrNull, oiBand, planOpen, positiveOrNull, type OpenPlan } from '../../lib/pulse/cohort.js';
import { marketRow } from '../../lib/pulse/metrics/market.js';
import { PULSE_CONFIG } from '../../lib/pulse/config.js';
import { HOUR_MS, SLOTS, cohortSlotMs, resolveSlots, snapshotGridMs, type Slot } from '../../lib/pulse/grid.js';
import {
  DEFAULT_OPTION_FEES, fetchChain, fetchOptionFeeRates, fetchPerpQuote, type ChainSnapshot, type FeeRates, type PerpQuote,
} from '../bot/delta-public.js';
import {
  closeCohorts, dbSizeBytes, ensurePulseSchema, gridIncomplete, insertCohort, insertSnapshot, lastLegSnapshots, latestGridMs,
  insertMarketRows, latestSeries, latestSlotMs, liveCohorts, logEvent, markStop, missedOpenSlots,
} from './pulse-store.js';

const TICK_MS = 60_000;
const GRID_MS = PULSE_CONFIG.snapshotMinutes * 60_000;
/** How far back a healthy tick looks for hours that got no cohort. */
const MISSED_OPEN_LOOKBACK_MS = 72 * HOUR_MS;
const LEGS = ['call', 'put'] as const satisfies readonly LegName[];

export interface PulseStatus {
  enabled: boolean;
  lastTickAt: number | null;
  /** The last tick that finished with good data and every write done. */
  lastGoodTickAt: number | null;
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

/** Why this chain and perp response cannot be trusted, or null if the API is live. This cannot see a frozen book; see FEED_FROZEN. */
function staleReason(chain: ChainSnapshot, perp: PerpQuote, nowMs: number): string | null {
  if (nowMs - perp.tsMs > PULSE_CONFIG.staleQuoteMs) return 'perp response too old';
  const times = chain.options.flatMap((o) => (o.responseTsMs === undefined ? [] : [o.responseTsMs]));
  if (times.length === 0) return 'no option has a response time';
  if (nowMs - Math.max(...times) > PULSE_CONFIG.staleQuoteMs) return 'chain response too old';
  return null;
}

/**
 * Strangle Pulse collector: opens one paper cohort per expiry slot each UTC hour and snapshots every live
 * cohort on the 15-minute grid. It reads public market data and writes only its own pulse_ tables, so nothing
 * here can reach the exchange's order API. The maths is pure (lib/pulse); this class schedules and persists.
 * State that matters is in the database; what is held in memory removes repeated events and holds stops not yet written.
 */
export class PulseEngine {
  lastTickAt: number | null = null;
  lastGoodTickAt: number | null = null;
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
  /** The grid whose market rows are stored. Separate from lastGrid, and not restored: a rewrite after a restart is a no-op. */
  private lastMarketGrid: number | null = null;
  private gapLoggedTo: number | null = null;
  private series: Partial<Record<Slot, string>> = {};
  /** The expiry each series belongs to. A slot whose expiry differs needs a new series. */
  private seriesExpiry: Slots = {};
  private slots: Slots = {};
  private live = zeroCounts();

  /** Unhealthy event types already logged in this outage. */
  private outageLogged = new Set<string>();
  private slotsLogged = new Set<Slot>();
  private fingerprint: string | null = null;
  private unchangedTicks = 0;
  /** Stops seen but not yet written, so a failed write survives the ask falling back. */
  private pendingStops = new Map<string, number>();
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
      lastGoodTickAt: this.lastGoodTickAt,
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
      this.dataOk = false;
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

    // A live API can serve a dead book: response times advance, prices do not.
    const fingerprint = feedFingerprint(chain.options, perp);
    this.unchangedTicks = fingerprint === this.fingerprint ? this.unchangedTicks + 1 : 0;
    this.fingerprint = fingerprint;
    if (this.unchangedTicks >= PULSE_CONFIG.frozenTicks) {
      return this.markUnhealthy('FEED_FROZEN', `feed frozen: book unchanged for ${this.unchangedTicks} ticks`, { ticks: this.unchangedTicks });
    }

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

    await this.checkStops(now, live, chain);
    const stillLive = await this.roll(now, live, slots, chain, perp);
    this.live = this.countLive(stillLive);
    this.rotateSeries(slots);
    await this.snapshot(now, stillLive, chain, perp);
    const marketOk = await this.collectMarket(now, slots, chain, perp);
    await this.open(now, slots, chain, perp);
    await this.logDbSize(now);
    if (!marketOk) return; // keep the market write's error and the last good tick
    this.lastError = null;
    this.lastGoodTickAt = now;
  }

  private async markUnhealthy(type: 'DATA_STALE' | 'CHAIN_INCOMPLETE' | 'FEED_FROZEN', error: string, detail: unknown): Promise<void> {
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

  /** Tests every open leg against the live chain, so a touch between grids or just before the roll is not lost. */
  private async checkStops(now: number, live: readonly PulseCohort[], chain: ChainSnapshot): Promise<void> {
    const key = (c: PulseCohort, leg: LegName) => `${c.id}:${leg}`;
    const stopAt = (c: PulseCohort, leg: LegName) => (leg === 'call' ? c.call_sl_at : c.put_sl_at);
    // Everything hit is noted before anything is written, so one failed write cannot lose another leg's touch.
    for (const c of live) {
      for (const leg of LEGS) {
        if (stopAt(c, leg) === null && !this.pendingStops.has(key(c, leg)) && stopHitNow(c, leg, chain.options)) this.pendingStops.set(key(c, leg), now);
      }
    }
    for (const c of live) {
      for (const leg of LEGS) {
        const at = this.pendingStops.get(key(c, leg));
        if (at === undefined) continue;
        await markStop(c.id, leg, at);
        this.pendingStops.delete(key(c, leg));
        if (leg === 'call') c.call_sl_at = at;
        else c.put_sl_at = at;
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
        for (const leg of LEGS) {
          const stopAt = leg === 'call' ? c.call_sl_at : c.put_sl_at;
          if (!built.legs[leg].sl_hit || stopAt !== null) continue;
          await markStop(c.id, leg, prev[leg]?.grid_ms ?? grid); // heals a stop only a row holds, at the grid that row records
        }
      } finally {
        // Stored even if markStop failed: this row's sticky sl_hit is what lets a later tick recover the stop.
        await insertSnapshot(built);
      }
    }
    this.lastGrid = grid; // only now: a failed write above must leave this grid for the next tick to retry
  }

  /** Skew and term structure for the slots resolved this tick, once per grid. A failure is recorded here and retried on the next tick; it never reaches the cohort work. */
  private async collectMarket(now: number, slots: Slots, chain: ChainSnapshot, perp: PerpQuote): Promise<boolean> {
    const grid = snapshotGridMs(now);
    if (grid === this.lastMarketGrid) return true;
    try {
      const rows = SLOTS.flatMap((slot) => {
        const expiryMs = slots[slot];
        return expiryMs === undefined ? [] : [marketRow(chain.options, slot, expiryMs, perp.spot, grid, now)];
      });
      await insertMarketRows(rows);
      this.lastMarketGrid = grid;
      return true;
    } catch (e) {
      this.lastError = `market snapshot write failed: ${errText(e)}`;
      console.error('[pulse]', this.lastError);
      return false;
    }
  }

  private async open(now: number, slots: Slots, chain: ChainSnapshot, perp: PerpQuote): Promise<void> {
    const slotMs = cohortSlotMs(now);
    const late = now - slotMs > PULSE_CONFIG.lateOpenGraceMs;
    const due: Array<{ slot: Slot; expiryMs: number; plan: OpenPlan }> = [];
    for (const slot of SLOTS) {
      const expiryMs = slots[slot];
      if (expiryMs === undefined) continue; // an unlisted slot could not have opened, so it missed nothing
      const newest = await latestSlotMs(slot);
      if (newest === slotMs) continue;
      await this.logMissedOpens(now, slot, newest);
      if (!late) due.push({ slot, expiryMs, plan: planOpen(chain.options, expiryMs) });
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
      const band = (o: typeof call) => oiBand(chain.options, o.type, expiryMs, o.strike);
      const stored = await insertCohort({
        ...base,
        status: 'open', closed_at: null, close_reason: null,
        spot_entry: perp.spot, fut_entry_bid: perp.bid, fut_entry_ask: perp.ask,
        call_symbol: call.symbol, put_symbol: put.symbol, call_strike: call.strike, put_strike: put.strike,
        call_bid: positiveOrNull(call.bid), put_bid: positiveOrNull(put.bid), call_mid: (call.bid + call.ask) / 2, put_mid: (put.bid + put.ask) / 2,
        call_delta: call.delta, put_delta: put.delta, call_theta: finiteOrNull(call.theta), put_theta: finiteOrNull(put.theta),
        call_iv: positiveOrNull(call.iv), put_iv: positiveOrNull(put.iv),
        call_gamma: finiteOrNull(call.gamma), put_gamma: finiteOrNull(put.gamma), call_vega: finiteOrNull(call.vega), put_vega: finiteOrNull(put.vega),
        call_oi_band: band(call), put_oi_band: band(put),
        fee: fees.get(call.symbol) ?? DEFAULT_OPTION_FEES, missing: null,
        call_sl_at: null, put_sl_at: null, net_pnl: null,
      });
      if (stored) this.live[slot]++;
    }
  }

  /** Logs each hour since the slot's newest row that has no cohort and is past its grace. The events are the dedupe, so restarts cannot repeat one. */
  private async logMissedOpens(now: number, slot: Slot, newest: number | null): Promise<void> {
    const current = cohortSlotMs(now);
    // A slot with no rows has no history to walk: only this hour can be said to be missed.
    const from = newest === null ? current : Math.max(newest + HOUR_MS, current - MISSED_OPEN_LOOKBACK_MS);
    const hours: number[] = [];
    for (let h = from; h <= current; h += HOUR_MS) if (now - h > PULSE_CONFIG.lateOpenGraceMs) hours.push(h);
    if (hours.length === 0) return;
    const logged = await missedOpenSlots(slot, from);
    for (const slotMs of hours) if (!logged.has(slotMs)) await logEvent('MISSED_OPEN', slot, { slotMs });
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
      call_gamma: null, put_gamma: null, call_vega: null, put_vega: null, call_oi_band: null, put_oi_band: null,
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
