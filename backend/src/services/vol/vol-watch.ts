/**
 * Every 5 minutes: read the volatility state, send regime / compression change alerts (Telegram + a notice in the
 * terminal), and, while a strangle is open and the market is Coiled or in a Squeeze, fire the compression-break
 * tripwire as a full-screen "exit" popup. State survives restarts. It never places, closes or blocks an order.
 */
import { pool } from '../../db/index.js';
import { initialState, tripwire, volTransitions, type VolAlert, type VolState } from '../../lib/vol/alerts.js';
import type { Bar, VolRead } from '../../lib/vol/regime.js';
import { alertService } from '../alert-service.js';
import { DESK_USER_ID } from '../auth-store.js';
import { deskEvents } from '../desk-events.js';
import { newsWatcher } from '../news/index.js';
import { watchService } from '../watch/sources.js';
import { cachedBars1h, volRead } from './vol-history.js';

const EVERY_MS = 5 * 60_000;
const TRIP_COOLDOWN_MS = 6 * 3_600_000;

export interface VolWatchDeps {
  now(): number;
  read(now: number): Promise<VolRead | null>;
  bars(): Bar[];
  /** True when the desk owner has an open position (bot, paper strategy or real Delta legs). */
  inTrade(): boolean;
  notify(a: VolAlert): Promise<void>;
  tripped(t: { direction: 'up' | 'down'; hi: number; lo: number; close: number; level: string }): Promise<void>;
  load(): Promise<(VolState & { lastTripAt?: number | null }) | null>;
  save(s: VolState & { lastTripAt?: number | null }): Promise<void>;
}

export class VolWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: (VolState & { lastTripAt?: number | null }) | null = null;
  private busy = false;
  constructor(private d: VolWatchDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, EVERY_MS);
    this.timer.unref?.();
    setTimeout(() => { void this.tick(); }, 30_000).unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.d.now();
      const r = await this.d.read(now);
      if (!r) return; // no history: say nothing rather than guess
      if (!this.state) this.state = (await this.d.load().catch(() => null)) ?? initialState(now);
      const { state, alerts } = volTransitions(this.state, r, now);
      for (const a of alerts) await this.d.notify(a).catch(() => undefined);
      let next = { ...state, lastTripAt: this.state.lastTripAt ?? null };

      const t = tripwire(r, this.d.bars(), now);
      if (t?.broken && this.d.inTrade() && t.key !== this.state.trippedKey && (!next.lastTripAt || now - next.lastTripAt >= TRIP_COOLDOWN_MS)) {
        await this.d.tripped({ direction: t.broken, hi: t.hi, lo: t.lo, close: t.close!, level: r.compression.level });
        next = { ...next, trippedKey: t.key, lastTripAt: now };
      }
      this.state = next;
      await this.d.save(next).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }
}

let ready: Promise<void> | null = null;
async function ensure(): Promise<void> {
  ready = ready ?? pool.query('CREATE TABLE IF NOT EXISTS vol_watch_state (id integer PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())').then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}

const usd = (x: number) => Math.round(x).toLocaleString('en-US');

export const volWatch = new VolWatch({
  now: () => Date.now(),
  read: (now) => volRead(now),
  bars: () => cachedBars1h(),
  inTrade: () => (watchService.snapshotFor(DESK_USER_ID)?.groups.length ?? 0) > 0,
  notify: async (a) => {
    deskEvents.emit('vol_alert', a);
    await alertService.sendNotification({ title: a.title, message: a.message, channels: ['telegram', 'ntfy', 'in_app'] });
  },
  tripped: async (t) => {
    await newsWatcher.raise({
      kind: 'tripwire', severity: 'HIGH', category: 'crash', reason: `Compression break ${t.direction === 'up' ? 'upward' : 'downward'}`,
      title: `BTC closed at ${usd(t.close)}, ${t.direction === 'up' ? 'above' : 'below'} the quiet range ${usd(t.lo)}–${usd(t.hi)} (${t.level}), with volatility expanding.`,
      message: 'Exit now: don’t wait for the 1:1 stop. A break out of a long silence often runs.',
    });
  },
  load: async () => {
    await ensure();
    const r = await pool.query('SELECT state FROM vol_watch_state WHERE id = 1');
    const v = r.rows[0]?.state;
    return v ? (typeof v === 'string' ? JSON.parse(v) : v) : null;
  },
  save: async (s) => {
    await ensure();
    await pool.query('INSERT INTO vol_watch_state (id, state, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(s)]);
  },
});
