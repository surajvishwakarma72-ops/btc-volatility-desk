import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import {
  accountView, applyTrade, cashDelta, feeFor, intrinsicAtExpiry, limitTradesThrough, payoffSummary, roundToTick, shouldLiquidate, signed, stopTriggered,
  unrealized, validateOrder, walk, type AccountView, type Instrument, type MarginMode, type OrderReq, type PayoffLeg, type Position, type Quote, type Side,
} from '../../lib/bot/paper-terminal.js';
import { portfolioMargin } from '../../lib/bot/portfolio-margin.js';
import { DAY, istDateKey, istMidnightMs } from '../../lib/bot/schedule.js';
import { DESK_USER_ID } from '../auth-store.js';
import type { WatchLeg } from '../../lib/watch/classify.js';
import { getWatchConfig } from '../watch/watch-store.js';
import { parseExpiry } from '../bot/delta-public.js';
import { DeltaMarket, type MarketProvider, type MarketSnapshot } from './market.js';

/**
 * The user's own Delta-style paper account. Separate from the bot: its own cash, orders, positions and fills.
 * Market orders walk the real L2 book; limit orders rest and fill only when the market trades through them;
 * stop orders trigger on the mark; fees come from the products API; margin follows Delta's portfolio margin.
 * It cannot place a real order: there is no exchange write path anywhere in this module.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS paper_account (
  id integer PRIMARY KEY DEFAULT 1,
  cash numeric NOT NULL,
  start_balance numeric NOT NULL,
  realized_total numeric NOT NULL DEFAULT 0,
  fees_total numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paper_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  kind text NOT NULL,
  side text NOT NULL,
  otype text NOT NULL,
  lots integer NOT NULL,
  filled_lots integer NOT NULL DEFAULT 0,
  price numeric,
  stop_price numeric,
  reduce_only boolean NOT NULL DEFAULT false,
  leverage integer,
  status text NOT NULL,
  avg_price numeric,
  fee numeric NOT NULL DEFAULT 0,
  reason text,
  oco_group uuid
);
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS basket_id uuid;
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS margin_mode text NOT NULL DEFAULT 'portfolio';
CREATE INDEX IF NOT EXISTS paper_orders_status_idx ON paper_orders (status, created_at);
CREATE TABLE IF NOT EXISTS paper_positions (
  symbol text PRIMARY KEY,
  kind text NOT NULL,
  lots integer NOT NULL,
  avg_entry numeric NOT NULL,
  leverage integer NOT NULL DEFAULT 10,
  realized numeric NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS paper_fills (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  order_id uuid,
  symbol text NOT NULL,
  kind text NOT NULL,
  side text NOT NULL,
  lots integer NOT NULL,
  price numeric NOT NULL,
  fee numeric NOT NULL,
  maker boolean NOT NULL,
  slippage_usd numeric NOT NULL DEFAULT 0,
  realized numeric NOT NULL DEFAULT 0,
  note text
);
CREATE INDEX IF NOT EXISTS paper_fills_at_idx ON paper_fills (at);
CREATE TABLE IF NOT EXISTS paper_strategies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  close_reason text,
  margin_at_entry numeric NOT NULL DEFAULT 0,
  net_premium numeric NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paper_strategy_legs (
  id bigserial PRIMARY KEY,
  strategy_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  lots integer NOT NULL,
  entry_price numeric NOT NULL,
  stop_price numeric,
  exit_price numeric,
  entry_fee numeric NOT NULL DEFAULT 0,
  exit_fee numeric NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS paper_strategy_legs_idx ON paper_strategy_legs (strategy_id);
ALTER TABLE paper_account ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE paper_account DROP CONSTRAINT IF EXISTS paper_account_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS paper_account_acct ON paper_account (account_id);
ALTER TABLE paper_positions ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE paper_positions DROP CONSTRAINT IF EXISTS paper_positions_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS paper_positions_acct_symbol ON paper_positions (account_id, symbol);
ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE paper_fills ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE paper_strategies ADD COLUMN IF NOT EXISTS account_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';
CREATE INDEX IF NOT EXISTS paper_orders_acct ON paper_orders (account_id, status);
CREATE INDEX IF NOT EXISTS paper_fills_acct ON paper_fills (account_id, at);
CREATE INDEX IF NOT EXISTS paper_strategies_acct ON paper_strategies (account_id, status);
`;

const START_BALANCE = Number(process.env.PAPER_START_USD ?? 10_000);
const DEFAULT_LEVERAGE = 10;
const EPS = 1e-9;

export interface OrderRow {
  id: string;
  createdAt: number;
  symbol: string;
  kind: 'option' | 'perp';
  side: Side;
  type: 'market' | 'limit' | 'stop_market';
  lots: number;
  filledLots: number;
  price: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  leverage: number | null;
  status: 'working' | 'filled' | 'cancelled' | 'rejected';
  avgPrice: number | null;
  fee: number;
  reason: string | null;
  ocoGroup: string | null;
  /** Set on every leg of a strategy placed from the builder. */
  basketId: string | null;
}

interface State {
  cash: number;
  start: number;
  mode: MarginMode;
  realizedTotal: number;
  feesTotal: number;
  positions: Map<string, Position>;
  working: OrderRow[];
}

export interface PlaceRequest extends OrderReq {
  /** Bracket for a new perpetual or option position: reduce-only exits placed when the entry fills (one cancels the other). */
  takeProfit?: number;
  stopLoss?: number;
}

export interface FillSim {
  ok: boolean;
  reason?: string;
  fee: number;
  realized: number;
  cashAfter: number;
  view: AccountView;
  newPos: Position | null;
  increases: boolean;
}

const mapOrder = (r: any): OrderRow => ({
  id: r.id,
  createdAt: new Date(r.created_at).getTime(),
  symbol: r.symbol,
  kind: r.kind,
  side: r.side,
  type: r.otype,
  lots: Number(r.lots),
  filledLots: Number(r.filled_lots),
  price: r.price == null ? null : Number(r.price),
  stopPrice: r.stop_price == null ? null : Number(r.stop_price),
  reduceOnly: !!r.reduce_only,
  leverage: r.leverage == null ? null : Number(r.leverage),
  status: r.status,
  avgPrice: r.avg_price == null ? null : Number(r.avg_price),
  fee: Number(r.fee),
  reason: r.reason ?? null,
  ocoGroup: r.oco_group ?? null,
  basketId: r.basket_id ?? null,
});

const money = (v: number) => `$${v.toFixed(2)}`;

let schemaReady: Promise<void> | null = null;
export function ensurePaperSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool.query(DDL).then(() => undefined);
    schemaReady.catch(() => { schemaReady = null; });
  }
  return schemaReady;
}

/** Option symbols look like C-BTC-82000-301026; used to settle a position after its contract has left the board. */
export function parseOptionSymbol(symbol: string): { type: 'call' | 'put'; strike: number; expiryMs: number } | null {
  const p = symbol.split('-');
  const expiryMs = parseExpiry(symbol);
  const strike = Number(p[2]);
  if ((p[0] !== 'C' && p[0] !== 'P') || expiryMs == null || !Number.isFinite(strike)) return null;
  return { type: p[0] === 'C' ? 'call' : 'put', strike, expiryMs };
}

export class PaperTerminal {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;
  lastTickAt = 0;
  /** Nothing is open or working, so the 5-second tick does not touch the database or the market until an order is placed. */
  private idle = false;

  constructor(private readonly market: MarketProvider = sharedMarket(), readonly accountId: string = DESK_USER_ID) {}

  /** True while this account has something open or working, so the shared timer knows to tick it. */
  get active(): boolean {
    return !this.idle;
  }

  get enabled(): boolean {
    return process.env.PAPER_TERMINAL !== 'false';
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void tickAllPaper(), 5_000);
    void discoverActiveAccounts().catch(() => undefined);
    void this.quick().catch(() => undefined); // the first visit finds the chain already loaded
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One operation at a time, so a tick and a click can never interleave on the same account. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- state ----------

  private accountReady = false;
  private async ensure(): Promise<void> {
    await ensurePaperSchema();
    if (this.accountReady) return;
    await pool.query(
      `INSERT INTO paper_account (account_id, cash, start_balance) VALUES ($2, $1, $1) ON CONFLICT (account_id) DO NOTHING`,
      [START_BALANCE, this.accountId],
    );
    this.accountReady = true;
  }

  /** Snapshot for a screen that only reads: instant when one is cached. */
  private quick(): Promise<MarketSnapshot> {
    return this.market.fast ? this.market.fast() : this.market.snapshot(4_000);
  }

  private async load(): Promise<State> {
    const [a, p, w] = await Promise.all([
      pool.query('SELECT * FROM paper_account WHERE account_id = $1', [this.accountId]),
      pool.query('SELECT * FROM paper_positions WHERE account_id = $1', [this.accountId]),
      pool.query(`SELECT * FROM paper_orders WHERE account_id = $1 AND status = 'working' ORDER BY created_at, id`, [this.accountId]),
    ]);
    const acct = a.rows[0]!;
    return {
      cash: Number(acct.cash),
      start: Number(acct.start_balance),
      mode: acct.margin_mode === 'standard' ? 'standard' : 'portfolio',
      realizedTotal: Number(acct.realized_total),
      feesTotal: Number(acct.fees_total),
      positions: new Map(
        (p.rows as any[]).map((r) => [r.symbol, { symbol: r.symbol, lots: Number(r.lots), avgEntry: Number(r.avg_entry), leverage: Number(r.leverage), realized: Number(r.realized) }]),
      ),
      working: (w.rows as any[]).map(mapOrder),
    };
  }

  private quoteFn(snap: MarketSnapshot): (symbol: string) => Quote | undefined {
    const rows = new Map(snap.rows.map((r) => [r.symbol, r]));
    return (symbol) => {
      if (symbol === snap.perp.symbol) return { bid: snap.perp.bid, ask: snap.perp.ask, mark: snap.perp.mark };
      const r = rows.get(symbol);
      return r ? { bid: r.bid, ask: r.ask, mark: r.mark } : undefined;
    };
  }

  private view(st: { cash: number; start: number; mode?: MarginMode }, positions: Iterable<Position>, snap: MarketSnapshot): AccountView {
    return accountView({ cash: st.cash, startBalance: st.start }, [...positions], snap.insts, { spot: snap.spot, nowMs: Date.now(), quote: this.quoteFn(snap) }, st.mode ?? 'portfolio');
  }

  // ---------- fills ----------

  /** What would happen to the account if this much traded at this price. No writes. */
  private simulate(st: State, inst: Instrument, snap: MarketSnapshot, side: Side, lots: number, price: number, maker: boolean, leverage: number): FillSim {
    const pos = st.positions.get(inst.symbol) ?? null;
    const { pos: np, realized } = applyTrade(pos, signed(side, lots), price, inst.contractValue, leverage, inst.symbol);
    const fee = feeFor(inst, price, lots, snap.spot, maker);
    const cashAfter = st.cash + cashDelta(inst, side, lots, price, fee, realized);
    const list = [...st.positions.values()].filter((p) => p.symbol !== inst.symbol);
    if (np && np.lots !== 0) list.push(np);
    const view = this.view({ cash: cashAfter, start: st.start, mode: st.mode }, list, snap);
    const increases = Math.abs(np?.lots ?? 0) > Math.abs(pos?.lots ?? 0);
    let reason: string | undefined;
    if (increases && view.available < -EPS) {
      reason = `insufficient margin: after this trade the account needs ${money(view.margin)} margin but equity is ${money(view.equity)} (short by ${money(-view.available)})`;
    } else if (increases && inst.kind === 'option' && cashAfter < -EPS) {
      reason = `not enough cash to pay the ${money(price * lots * inst.contractValue)} premium plus fees (cash ${money(st.cash)})`;
    }
    return { ok: !reason, reason, fee, realized, cashAfter, view, newPos: np && np.lots !== 0 ? np : null, increases };
  }

  /** Apply a fill to the account and the order, and record it. The caller has already simulated it. */
  private async commit(st: State, o: OrderRow, inst: Instrument, sim: FillSim, lots: number, price: number, maker: boolean, bestPrice: number, note?: string): Promise<void> {
    const sym = inst.symbol;
    const slip = maker || !Number.isFinite(bestPrice) ? 0 : Math.abs(price - bestPrice) * lots * inst.contractValue;
    await pool.query(
      `INSERT INTO paper_fills (order_id, symbol, kind, side, lots, price, fee, maker, slippage_usd, realized, note, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [o.id, sym, inst.kind, o.side, lots, price, sim.fee, maker, slip, sim.realized, note ?? null, this.accountId],
    );
    if (sim.newPos) {
      await pool.query(
        `INSERT INTO paper_positions (symbol, kind, lots, avg_entry, leverage, realized, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (account_id, symbol) DO UPDATE SET lots = EXCLUDED.lots, avg_entry = EXCLUDED.avg_entry, leverage = EXCLUDED.leverage, realized = EXCLUDED.realized,
           opened_at = CASE WHEN paper_positions.lots = 0 THEN now() ELSE paper_positions.opened_at END`,
        [sym, inst.kind, sim.newPos.lots, sim.newPos.avgEntry, sim.newPos.leverage, sim.newPos.realized, this.accountId],
      );
      st.positions.set(sym, sim.newPos);
    } else {
      await pool.query('DELETE FROM paper_positions WHERE symbol = $1 AND account_id = $2', [sym, this.accountId]);
      st.positions.delete(sym);
    }
    await pool.query(
      `UPDATE paper_account SET cash = $1, realized_total = realized_total + $2, fees_total = fees_total + $3, updated_at = now() WHERE account_id = $4`,
      [sim.cashAfter, sim.realized, sim.fee, this.accountId],
    );
    st.cash = sim.cashAfter;
    st.realizedTotal += sim.realized;
    st.feesTotal += sim.fee;
    const prevValue = (o.avgPrice ?? 0) * o.filledLots;
    o.filledLots += lots;
    o.avgPrice = (prevValue + price * lots) / o.filledLots;
    o.fee += sim.fee;
    const done = o.filledLots >= o.lots;
    await pool.query(
      `UPDATE paper_orders SET filled_lots = $2, avg_price = $3, fee = $4, status = $5, updated_at = now() WHERE id = $1`,
      [o.id, o.filledLots, o.avgPrice, o.fee, done ? 'filled' : 'working'],
    );
    if (done) o.status = 'filled';
  }

  private async finish(o: OrderRow, status: 'cancelled' | 'rejected', reason: string): Promise<void> {
    o.status = status;
    o.reason = reason;
    await pool.query(`UPDATE paper_orders SET status = $2, reason = $3, updated_at = now() WHERE id = $1`, [o.id, status, reason]);
  }

  private async cancelSiblings(st: State, o: OrderRow, reason: string): Promise<void> {
    if (!o.ocoGroup) return;
    for (const s of st.working) {
      if (s.id !== o.id && s.ocoGroup === o.ocoGroup && s.status === 'working') await this.finish(s, 'cancelled', reason);
    }
  }

  /** Walk the real book now and fill as a taker. Returns the unfilled remainder (0 when complete). */
  private async takeFromBook(st: State, o: OrderRow, inst: Instrument, snap: MarketSnapshot, limit?: number): Promise<{ left: number; failed?: string }> {
    const remaining = o.lots - o.filledLots;
    const book = await this.market.book(o.symbol);
    const w = walk(o.side === 'buy' ? book.asks : book.bids, o.side, remaining, limit);
    if (w.filled === 0) return { left: remaining };
    const leverage = o.leverage ?? st.positions.get(o.symbol)?.leverage ?? DEFAULT_LEVERAGE;
    const sim = this.simulate(st, inst, snap, o.side, w.filled, w.avgPrice, false, leverage);
    if (!sim.ok) return { left: remaining, failed: sim.reason };
    await this.commit(st, o, inst, sim, w.filled, w.avgPrice, false, w.best, w.filled < remaining ? 'partial: book depth' : undefined);
    return { left: remaining - w.filled };
  }

  // ---------- public operations ----------

  /** Estimate a market/limit order against the live book without placing it. */
  preview(req: PlaceRequest) {
    return this.serial(async () => {
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const st = await this.load();
      const inst = snap.insts.get(req.symbol);
      if (!inst) return { ok: false, reason: 'unknown contract: it is not listed (or has expired)' };
      const err = validateOrder(req, inst, st.positions.get(req.symbol) ?? null);
      if (err) return { ok: false, reason: err };
      const book = await this.market.book(req.symbol);
      const limit = req.type === 'limit' ? roundToTick(req.price!, inst.tick) : undefined;
      const w = walk(req.side === 'buy' ? book.asks : book.bids, req.side, req.lots, req.type === 'stop_market' ? undefined : limit);
      const leverage = req.leverage ?? st.positions.get(req.symbol)?.leverage ?? DEFAULT_LEVERAGE;
      const base = this.view(st, st.positions.values(), snap);
      const refPrice = w.filled > 0 ? w.avgPrice : limit ?? (req.type === 'stop_market' ? roundToTick(req.stopPrice!, inst.tick) : NaN);
      const refLots = w.filled > 0 ? w.filled : req.lots;
      if (!(refPrice > 0)) return { ok: true, fills: 0, note: 'The book has no liquidity on this side, so there is no price to estimate from.' };
      const sim = this.simulate(st, inst, snap, req.side, refLots, refPrice, w.filled === 0, leverage);
      const premium = inst.kind === 'option' ? (req.side === 'sell' ? 1 : -1) * refPrice * refLots * inst.contractValue : null;
      const resting = w.filled === 0;
      return {
        ok: sim.ok, reason: sim.reason, fills: w.filled, avgPrice: refPrice, bestPrice: w.filled > 0 ? w.best : refPrice,
        slippageUsd: w.filled > 0 ? Math.abs(w.avgPrice - w.best) * w.filled * inst.contractValue : 0, fee: sim.fee,
        marginBefore: base.margin, marginAfter: sim.view.margin, marginRequired: sim.view.margin - base.margin, availableAfter: sim.view.available, marginMode: st.mode,
        premium, resting, partial: w.filled > 0 && w.filled < req.lots,
        note: resting
          ? (req.type === 'limit' ? 'Not marketable now: this limit order would rest in the book. The estimate assumes it fills at your price.' : 'A stop order waits for its trigger. The estimate assumes it fills at the trigger price.')
          : w.filled < req.lots ? `Only ${w.filled} of ${req.lots} lots are available${limit != null ? ' at your limit' : ''}.` : undefined,
      };
    });
  }

  place(req: PlaceRequest) {
    return this.serial(async () => {
      this.idle = false;
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const st = await this.load();
      const inst = snap.insts.get(req.symbol);
      const insertOrder = async (extra: Partial<OrderRow> = {}): Promise<OrderRow> => {
        const o: OrderRow = {
          id: randomUUID(), createdAt: Date.now(), symbol: req.symbol, kind: inst?.kind ?? (req.symbol === snap.perp.symbol ? 'perp' : 'option'),
          side: req.side, type: req.type, lots: req.lots, filledLots: 0, price: req.price ?? null, stopPrice: req.stopPrice ?? null,
          reduceOnly: !!req.reduceOnly, leverage: req.leverage ?? null, status: 'working', avgPrice: null, fee: 0, reason: null, ocoGroup: null, basketId: null, ...extra,
        };
        await pool.query(
          `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, price, stop_price, reduce_only, leverage, status, reason, oco_group, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [o.id, o.symbol, o.kind, o.side, o.type, o.lots, o.price, o.stopPrice, o.reduceOnly, o.leverage, o.status, o.reason, o.ocoGroup, this.accountId],
        );
        return o;
      };
      const reject = async (reason: string) => {
        const o = await insertOrder();
        await this.finish(o, 'rejected', reason);
        return { order: o, fills: [] as unknown[], children: [] as OrderRow[] };
      };

      if (!inst) return reject('unknown contract: it is not listed (or has expired)');
      const pos = st.positions.get(req.symbol) ?? null;
      const err = validateOrder(req, inst, pos);
      if (err) return reject(err);

      let lots = req.lots;
      let note: string | null = null;
      if (req.reduceOnly && pos && lots > Math.abs(pos.lots)) {
        lots = Math.abs(pos.lots);
        note = `reduce-only: size cut from ${req.lots} to ${lots} lots to match the position`;
      }
      const price = req.type === 'limit' ? roundToTick(req.price!, inst.tick) : undefined;
      const stop = req.type === 'stop_market' ? roundToTick(req.stopPrice!, inst.tick) : undefined;
      const q = this.quoteFn(snap)(req.symbol);
      if (!q) return reject('no live quote for this contract');
      const markNow = q.mark > 0 ? q.mark : (q.bid + q.ask) / 2;
      if (stop != null && stopTriggered(req.side, stop, markNow)) {
        return reject(`stop price ${stop} would trigger immediately (mark is ${markNow.toFixed(2)}); a ${req.side} stop must be ${req.side === 'buy' ? 'above' : 'below'} the mark`);
      }
      if ((req.takeProfit != null || req.stopLoss != null)) {
        if (req.reduceOnly) return reject('a bracket cannot be attached to a reduce-only order');
        const long = req.side === 'buy';
        if (req.takeProfit != null && (long ? req.takeProfit <= markNow : req.takeProfit >= markNow)) return reject(`take-profit ${req.takeProfit} must be ${long ? 'above' : 'below'} the mark ${markNow.toFixed(2)}`);
        if (req.stopLoss != null && (long ? req.stopLoss >= markNow : req.stopLoss <= markNow)) return reject(`stop-loss ${req.stopLoss} must be ${long ? 'below' : 'above'} the mark ${markNow.toFixed(2)}`);
        if (req.type !== 'market' && req.type !== 'limit') return reject('a bracket can be attached to market and limit entries only');
      }

      const o = await insertOrder({ lots, price: price ?? null, stopPrice: stop ?? null, reason: note });
      if (note) await pool.query('UPDATE paper_orders SET lots = $2, reason = $3 WHERE id = $1', [o.id, lots, note]);
      st.working.push(o);

      if (req.type === 'market' || req.type === 'limit') {
        const r = await this.takeFromBook(st, o, inst, snap, price);
        if (r.failed) {
          await this.finish(o, 'rejected', r.failed);
        } else if (req.type === 'market' && o.filledLots === 0) {
          await this.finish(o, 'cancelled', 'no liquidity: the book has nothing on this side');
        } else if (req.type === 'market' && r.left > 0) {
          await this.finish(o, 'cancelled', `book depth: only ${o.filledLots} of ${o.lots} lots filled, the rest was cancelled`);
          o.status = 'cancelled';
        }
        // an unfilled limit remainder simply rests
      }

      let children: OrderRow[] = [];
      if (o.filledLots > 0 && (req.takeProfit != null || req.stopLoss != null)) children = await this.placeBracket(st, o, inst, req, markNow);
      await this.afterFills(st, snap);
      return { order: o, fills: [], children };
    });
  }

  private async placeBracket(st: State, parent: OrderRow, inst: Instrument, req: PlaceRequest, _mark: number): Promise<OrderRow[]> {
    const group = randomUUID();
    const exitSide: Side = parent.side === 'buy' ? 'sell' : 'buy';
    const out: OrderRow[] = [];
    const mk = async (type: 'limit' | 'stop_market', px: number) => {
      const c: OrderRow = {
        id: randomUUID(), createdAt: Date.now(), symbol: parent.symbol, kind: parent.kind, side: exitSide, type, lots: parent.filledLots, filledLots: 0,
        price: type === 'limit' ? roundToTick(px, inst.tick) : null, stopPrice: type === 'stop_market' ? roundToTick(px, inst.tick) : null,
        reduceOnly: true, leverage: null, status: 'working', avgPrice: null, fee: 0, reason: 'bracket exit', ocoGroup: group, basketId: null,
      };
      await pool.query(
        `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, price, stop_price, reduce_only, leverage, status, reason, oco_group, account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NULL,'working',$9,$10,$11)`,
        [c.id, c.symbol, c.kind, c.side, c.type, c.lots, c.price, c.stopPrice, c.reason, c.ocoGroup, this.accountId],
      );
      st.working.push(c);
      out.push(c);
    };
    if (req.takeProfit != null) await mk('limit', req.takeProfit);
    if (req.stopLoss != null) await mk('stop_market', req.stopLoss);
    return out;
  }

  cancel(id: string) {
    return this.serial(async () => {
      await this.ensure();
      const r = await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled by you', updated_at = now() WHERE id = $1 AND account_id = $2 AND status = 'working' RETURNING id, oco_group`, [id, this.accountId]);
      if (!r.rowCount) return false;
      const g = (r.rows[0] as any).oco_group;
      if (g) await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled with its bracket partner', updated_at = now() WHERE oco_group = $1 AND account_id = $2 AND status = 'working'`, [g, this.accountId]);
      return true;
    });
  }

  cancelAll() {
    return this.serial(async () => {
      await this.ensure();
      const r = await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled by you', updated_at = now() WHERE account_id = $1 AND status = 'working'`, [this.accountId]);
      return r.rowCount ?? 0;
    });
  }

  setLeverage(symbol: string, leverage: number) {
    return this.serial(async () => {
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const inst = snap.insts.get(symbol);
      if (!inst || inst.kind !== 'perp') return { ok: false, reason: 'leverage can be set on the perpetual only' };
      if (!Number.isFinite(leverage) || leverage < 1 || leverage > inst.maxLeverage) return { ok: false, reason: `leverage must be between 1 and ${inst.maxLeverage}` };
      const st = await this.load();
      const pos = st.positions.get(symbol);
      if (pos) {
        const test = this.view(st, [{ ...pos, leverage }, ...[...st.positions.values()].filter((p) => p.symbol !== symbol)], snap);
        if (test.available < -EPS) return { ok: false, reason: `${leverage}x would need ${money(test.margin)} margin, more than the ${money(test.equity)} equity you have` };
        await pool.query('UPDATE paper_positions SET leverage = $2 WHERE symbol = $1 AND account_id = $3', [symbol, leverage, this.accountId]);
      }
      return { ok: true };
    });
  }

  reset(balance: number) {
    return this.serial(async () => {
      await ensurePaperSchema();
      const mine = [this.accountId];
      await pool.query('DELETE FROM paper_strategy_legs WHERE strategy_id IN (SELECT id FROM paper_strategies WHERE account_id = $1)', mine);
      for (const t of ['paper_fills', 'paper_orders', 'paper_positions', 'paper_strategies', 'paper_account']) await pool.query(`DELETE FROM ${t} WHERE account_id = $1`, mine);
      await pool.query('INSERT INTO paper_account (account_id, cash, start_balance) VALUES ($2, $1, $1)', [balance, this.accountId]);
      this.accountReady = true;
      this.idle = false;
    });
  }

  /** Account snapshot: balances, margin, positions with live PnL, and working orders. */
  account() {
    return this.serial(async () => {
      await this.ensure();
      const st = await this.load();
      let snap: MarketSnapshot | null = null;
      let marketError: string | null = null;
      try { snap = await this.quick(); } catch (e) { marketError = (e as Error).message; }
      if (!snap) {
        return { account: { cash: st.cash, startBalance: st.start, realizedTotal: st.realizedTotal, feesTotal: st.feesTotal }, marginMode: st.mode, view: null, positions: [], working: st.working, marketError };
      }
      const q = this.quoteFn(snap);
      const view = this.view(st, st.positions.values(), snap);
      const onlyPerp = st.positions.size === 1 ? [...st.positions.values()][0]! : null;
      const positions = [...st.positions.values()].map((p) => {
        const inst = snap!.insts.get(p.symbol);
        const quote = q(p.symbol);
        const mark = quote ? (quote.mark > 0 ? quote.mark : (quote.bid + quote.ask) / 2) : null;
        const cv = inst?.contractValue ?? 0.001;
        const upnl = mark != null ? unrealized(p, mark, cv) : null;
        // portfolio mode has no per-position leverage: the margin comes from the stress scenarios, and the leverage that implies is value / margin
        const pm = inst?.kind === 'perp' && mark != null && st.mode === 'portfolio' ? portfolioMargin([], snap!.spot, Date.now(), 0.001, p.lots).margin : null;
        const lev = pm ? (Math.abs(p.lots) * cv * mark!) / pm : p.leverage;
        let liq: number | null = null;
        if (onlyPerp && inst?.kind === 'perp') {
          const L = Math.abs(p.lots) * cv;
          liq = p.lots > 0 ? (L * p.avgEntry - st.cash) / (L * (1 - 0.5 / lev)) : (st.cash + L * p.avgEntry) / (L * (1 + 0.5 / lev));
          if (!(liq > 0)) liq = null;
        }
        return {
          symbol: p.symbol, kind: inst?.kind ?? (p.symbol.includes('-') ? 'option' : 'perp'), lots: p.lots, avgEntry: p.avgEntry, leverage: lev, mark,
          unrealized: upnl, realized: p.realized,
          margin: inst?.kind === 'perp' && mark != null ? (pm ?? (Math.abs(p.lots) * cv * mark) / p.leverage) : null,
          liquidationPrice: liq,
          delta: snap!.rows.find((r) => r.symbol === p.symbol)?.delta ?? null,
        };
      });
      return {
        account: { cash: st.cash, startBalance: st.start, realizedTotal: st.realizedTotal, feesTotal: st.feesTotal },
        marginMode: st.mode, view, positions, greeks: this.netGreeks(st, snap), working: st.working, spot: snap.spot, perp: snap.perp, marketError,
      };
    });
  }

  /** Net exposure of the whole account: delta in BTC (the perpetual counts one for one), and the option greeks scaled to the size held. */
  private netGreeks(st: State, snap: MarketSnapshot) {
    const rows = new Map(snap.rows.map((r) => [r.symbol, r]));
    let delta = 0, gamma = 0, theta = 0, vega = 0;
    for (const p of st.positions.values()) {
      if (p.symbol === snap.perp.symbol) { delta += p.lots * 0.001; continue; }
      const r = rows.get(p.symbol);
      if (!r) continue;
      const size = p.lots * 0.001;
      delta += size * r.delta; gamma += size * r.gamma; theta += size * r.theta; vega += size * r.vega;
    }
    return { delta, gamma, theta, vega };
  }

  // ---------- margin mode and multi-leg strategies ----------

  /** Switch between portfolio margin and standard margin. Refused if the account could not carry its positions under the new mode. */
  setMarginMode(mode: MarginMode) {
    return this.serial(async () => {
      await this.ensure();
      if (mode !== 'portfolio' && mode !== 'standard') return { ok: false, reason: 'mode must be portfolio or standard' };
      const st = await this.load();
      if (st.mode === mode) return { ok: true, mode };
      if (st.positions.size) {
        const snap = await this.market.snapshot(2_000);
        const v = this.view({ cash: st.cash, start: st.start, mode }, st.positions.values(), snap);
        if (v.available < -EPS) {
          return { ok: false, reason: `${mode} margin would need ${money(v.margin)} for the positions you hold, more than the ${money(v.equity)} of equity. Close some positions first.` };
        }
      }
      await pool.query('UPDATE paper_account SET margin_mode = $1, updated_at = now() WHERE account_id = $2', [mode, this.accountId]);
      return { ok: true, mode };
    });
  }

  /** Walk the real books for every leg and apply them together, so a hedged package is margined as one position. */
  private async planBasket(st: State, snap: MarketSnapshot, legs: BasketLeg[]) {
    const fail = (reason: string) => ({ ok: false as const, reason });
    if (!legs.length || legs.length > 8) return fail('a strategy needs between 1 and 8 legs');
    const planned: Array<{ inst: Instrument; side: Side; lots: number; price: number; best: number }> = [];
    for (const l of legs) {
      const inst = snap.insts.get(l.symbol);
      if (!inst) return fail(`${l.symbol} is not listed (or has expired)`);
      if (!Number.isInteger(l.lots) || l.lots < 1) return fail('every leg needs a whole number of lots, at least 1');
      const book = await this.market.book(l.symbol);
      const w = walk(l.side === 'buy' ? book.asks : book.bids, l.side, l.lots);
      if (w.filled < l.lots) return fail(`${l.symbol}: the book has only ${w.filled} of ${l.lots} lots on the ${l.side === 'buy' ? 'ask' : 'bid'} side, so the whole strategy cannot be filled at once`);
      planned.push({ inst, side: l.side, lots: l.lots, price: w.avgPrice, best: w.best });
    }
    let cash = st.cash;
    let fees = 0;
    let slippageUsd = 0;
    let netPremium = 0;
    const pos = new Map(st.positions);
    for (const p of planned) {
      const cur = pos.get(p.inst.symbol) ?? null;
      const { pos: np, realized } = applyTrade(cur, signed(p.side, p.lots), p.price, p.inst.contractValue, cur?.leverage ?? DEFAULT_LEVERAGE, p.inst.symbol);
      const fee = feeFor(p.inst, p.price, p.lots, snap.spot, false);
      cash += cashDelta(p.inst, p.side, p.lots, p.price, fee, realized);
      fees += fee;
      slippageUsd += Math.abs(p.price - p.best) * p.lots * p.inst.contractValue;
      if (p.inst.kind === 'option') netPremium += (p.side === 'sell' ? 1 : -1) * p.price * p.lots * p.inst.contractValue;
      if (np && np.lots !== 0) pos.set(p.inst.symbol, np);
      else pos.delete(p.inst.symbol);
    }
    const view = this.view({ cash, start: st.start, mode: st.mode }, pos.values(), snap);
    const grows = [...new Set(planned.map((p) => p.inst.symbol))].some((s) => Math.abs(pos.get(s)?.lots ?? 0) > Math.abs(st.positions.get(s)?.lots ?? 0));
    let reason: string | undefined;
    if (grows && view.available < -EPS) {
      reason = `insufficient margin: ${st.mode} margin for this strategy plus your positions is ${money(view.margin)}, but equity would be ${money(view.equity)} (short by ${money(-view.available)})`;
    } else if (grows && planned.some((p) => p.inst.kind === 'option' && p.side === 'buy') && cash < -EPS) {
      reason = `not enough cash to pay the net premium and fees (cash would be ${money(cash)})`;
    }
    const opts = planned.filter((p) => p.inst.kind === 'option');
    const sameExpiry = opts.length === planned.length && new Set(opts.map((p) => p.inst.option!.expiryMs)).size === 1;
    const payoff = sameExpiry
      ? payoffSummary(opts.map((p): PayoffLeg => ({ type: p.inst.option!.type, strike: p.inst.option!.strike, side: p.side, lots: p.lots, price: p.price, contractValue: p.inst.contractValue })), snap.spot)
      : null;
    return { ok: !reason, reason, planned, view, fees, slippageUsd, netPremium, cashAfter: cash, payoff, spot: snap.spot };
  }

  /** Estimate a multi-leg strategy against the live books without placing it. */
  previewBasket(legs: BasketLeg[]) {
    return this.serial(async () => {
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const st = await this.load();
      const p = await this.planBasket(st, snap, legs);
      if (!('planned' in p)) return { ok: false, reason: p.reason };
      return {
        ok: p.ok, reason: p.reason,
        legs: p.planned.map((x) => ({ symbol: x.inst.symbol, side: x.side, lots: x.lots, avgPrice: x.price, bestPrice: x.best })),
        netPremium: p.netPremium, fees: p.fees, slippageUsd: p.slippageUsd,
        marginBefore: this.view(st, st.positions.values(), snap).margin, marginAfter: p.view.margin, marginRequired: p.view.margin - this.view(st, st.positions.values(), snap).margin,
        availableAfter: p.view.available, marginMode: st.mode, payoff: p.payoff,
      };
    });
  }

  /** Place every leg at once as market orders, or none. */
  placeBasket(legs: BasketLeg[], name?: string) {
    return this.serial(async () => {
      this.idle = false;
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const st = await this.load();
      const p = await this.planBasket(st, snap, legs);
      if (!('planned' in p) || !p.ok) return { ok: false, reason: p.reason ?? 'could not plan the strategy', orders: [] as OrderRow[] };
      // stops: a sold option defaults to 2x its sell price, and a stop must sit on the losing side of the fill
      const stops: Array<number | null> = [];
      for (let i = 0; i < p.planned.length; i++) {
        const leg = p.planned[i]!;
        const asked = legs[i]!.stop;
        const stop = asked === undefined ? (leg.side === 'sell' && leg.inst.kind === 'option' ? roundToTick(leg.price * DEFAULT_STOP_MULT, leg.inst.tick) : null) : asked;
        if (stop != null && (leg.side === 'sell' ? stop <= leg.price : stop >= leg.price)) {
          return { ok: false, reason: `${leg.inst.symbol}: a ${leg.side === 'sell' ? 'sold' : 'bought'} leg filled near ${leg.price.toFixed(1)} needs its stop ${leg.side === 'sell' ? 'above' : 'below'} that, not at ${stop}`, orders: [] as OrderRow[] };
        }
        stops.push(stop);
      }
      const marginBefore = this.view(st, st.positions.values(), snap).margin;
      const basketId = randomUUID();
      const orders: OrderRow[] = [];
      const legFees: number[] = [];
      for (const leg of p.planned) {
        const o: OrderRow = {
          id: randomUUID(), createdAt: Date.now(), symbol: leg.inst.symbol, kind: leg.inst.kind, side: leg.side, type: 'market', lots: leg.lots, filledLots: 0,
          price: null, stopPrice: null, reduceOnly: false, leverage: null, status: 'working', avgPrice: null, fee: 0, reason: 'strategy leg', ocoGroup: null, basketId,
        };
        await pool.query(
          `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, reduce_only, status, reason, basket_id, account_id) VALUES ($1,$2,$3,$4,'market',$5,false,'working','strategy leg',$6,$7)`,
          [o.id, o.symbol, o.kind, o.side, o.lots, basketId, this.accountId],
        );
        // the whole package was checked together above, so each leg is applied without a separate margin test
        const lev = st.positions.get(o.symbol)?.leverage ?? DEFAULT_LEVERAGE;
        const sim = this.simulate(st, leg.inst, snap, leg.side, leg.lots, leg.price, false, lev);
        await this.commit(st, o, leg.inst, sim, leg.lots, leg.price, false, leg.best, 'strategy leg');
        orders.push(o);
        legFees.push(sim.fee);
      }
      const label = name?.trim() || p.planned.map((l) => `${l.side === 'sell' ? 'S' : 'B'} ${l.inst.option ? `${l.inst.option.strike}${l.inst.option.type === 'call' ? 'C' : 'P'}` : l.inst.symbol}`).join(' · ');
      await pool.query(
        `INSERT INTO paper_strategies (id, name, margin_at_entry, net_premium, account_id) VALUES ($1,$2,$3,$4,$5)`,
        [basketId, label.slice(0, 120), Math.max(p.view.margin - marginBefore, 0), p.netPremium, this.accountId],
      );
      for (let i = 0; i < p.planned.length; i++) {
        const leg = p.planned[i]!;
        await pool.query(
          `INSERT INTO paper_strategy_legs (strategy_id, symbol, side, lots, entry_price, stop_price, entry_fee) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [basketId, leg.inst.symbol, leg.side, leg.lots, leg.price, stops[i], legFees[i]],
        );
      }
      await this.afterFills(st, snap);
      return { ok: true, basketId, orders, netPremium: p.netPremium, fees: p.fees, payoff: p.payoff, stops };
    });
  }

  // ---------- strategy positions: net and per-leg PnL, per-leg stops, close all ----------

  private markOf(q: Quote | undefined): number | null {
    return q ? (q.mark > 0 ? q.mark : (q.bid + q.ask) / 2) : null;
  }

  /**
   * Close every still-open leg of one strategy with reverse market orders against the live books (the remainder at the
   * mark if the book is too thin), record each leg's exit price and fee, and mark the strategy closed.
   */
  private async closeStrategyLegs(st: State, snap: MarketSnapshot, id: string, reason: string): Promise<boolean> {
    const legs = (await pool.query('SELECT * FROM paper_strategy_legs WHERE strategy_id = $1 AND exit_price IS NULL ORDER BY id', [id])).rows as any[];
    const q = this.quoteFn(snap);
    for (const l of legs) {
      const lots = Number(l.lots);
      const inst = snap.insts.get(l.symbol);
      const pos = st.positions.get(l.symbol);
      const mark = this.markOf(q(l.symbol));
      if (!inst || !pos) {
        // the contract expired or the position was closed another way: price it where we last can
        const opt = parseOptionSymbol(l.symbol);
        const px = opt && opt.expiryMs <= Date.now() ? intrinsicAtExpiry(opt.type, opt.strike, snap.spot) : mark ?? Number(l.entry_price);
        await pool.query('UPDATE paper_strategy_legs SET exit_price = $2 WHERE id = $1', [l.id, px]);
        continue;
      }
      const side: Side = l.side === 'buy' ? 'sell' : 'buy';
      const o: OrderRow = {
        id: randomUUID(), createdAt: Date.now(), symbol: l.symbol, kind: inst.kind, side, type: 'market', lots, filledLots: 0, price: null, stopPrice: null,
        reduceOnly: true, leverage: null, status: 'working', avgPrice: null, fee: 0, reason: 'strategy close', ocoGroup: null, basketId: id,
      };
      await pool.query(
        `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, reduce_only, status, reason, basket_id, account_id) VALUES ($1,$2,$3,$4,'market',$5,true,'working','strategy close',$6,$7)`,
        [o.id, o.symbol, o.kind, o.side, o.lots, id, this.accountId],
      );
      await this.takeFromBook(st, o, inst, snap);
      if (o.filledLots < lots) {
        const rest = lots - o.filledLots;
        const px = mark ?? Number(l.entry_price);
        const sim = this.simulate(st, inst, snap, side, rest, px, false, pos.leverage);
        await this.commit(st, o, inst, sim, rest, px, false, px, 'strategy close at the mark: the book was too thin');
      }
      await pool.query('UPDATE paper_strategy_legs SET exit_price = $2, exit_fee = $3 WHERE id = $1', [l.id, o.avgPrice, o.fee]);
    }
    await pool.query(`UPDATE paper_strategies SET status = 'closed', closed_at = now(), close_reason = $2 WHERE id = $1 AND status = 'open'`, [id, reason]);
    return true;
  }

  /** Close all legs of a strategy now. */
  closeStrategy(id: string, reason = 'closed by you') {
    return this.serial(async () => {
      await this.ensure();
      const s = (await pool.query(`SELECT status FROM paper_strategies WHERE id = $1 AND account_id = $2`, [id, this.accountId])).rows[0] as { status: string } | undefined;
      if (!s) return { ok: false, reason: 'no strategy with that id' };
      if (s.status !== 'open') return { ok: false, reason: 'that strategy is already closed' };
      const snap = await this.market.snapshot(1_500);
      const st = await this.load();
      await this.closeStrategyLegs(st, snap, id, reason);
      await this.afterFills(st, snap);
      return { ok: true };
    });
  }

  /** Change the stop of individual legs of an open strategy; null removes a stop. */
  setStops(id: string, stops: Array<{ symbol: string; stop: number | null }>) {
    return this.serial(async () => {
      await this.ensure();
      const s = (await pool.query(`SELECT status FROM paper_strategies WHERE id = $1 AND account_id = $2`, [id, this.accountId])).rows[0] as { status: string } | undefined;
      if (!s) return { ok: false, reason: 'no strategy with that id' };
      if (s.status !== 'open') return { ok: false, reason: 'that strategy is already closed' };
      const legs = (await pool.query('SELECT * FROM paper_strategy_legs WHERE strategy_id = $1 AND exit_price IS NULL', [id])).rows as any[];
      for (const c of stops) {
        const l = legs.find((x) => x.symbol === c.symbol);
        if (!l) return { ok: false, reason: `${c.symbol} is not an open leg of this strategy` };
        if (c.stop != null) {
          const entry = Number(l.entry_price);
          if (l.side === 'sell' ? c.stop <= entry : c.stop >= entry) {
            return { ok: false, reason: `${c.symbol}: the stop for a ${l.side === 'sell' ? 'sold' : 'bought'} leg must be ${l.side === 'sell' ? 'above' : 'below'} its entry ${entry.toFixed(1)}` };
          }
        }
      }
      for (const c of stops) {
        await pool.query('UPDATE paper_strategy_legs SET stop_price = $3 WHERE strategy_id = $1 AND symbol = $2 AND exit_price IS NULL', [id, c.symbol, c.stop]);
      }
      return { ok: true };
    });
  }

  /** Close any open strategy whose leg has reached its stop. The whole strategy goes, not just that leg. */
  private async checkStops(st: State, snap: MarketSnapshot): Promise<void> {
    const rows = (await pool.query(
      `SELECT l.* FROM paper_strategy_legs l JOIN paper_strategies s ON s.id = l.strategy_id
       WHERE s.status = 'open' AND s.account_id = $1 AND l.exit_price IS NULL AND l.stop_price IS NOT NULL ORDER BY l.id`,
      [this.accountId],
    )).rows as any[];
    if (!rows.length) return;
    const q = this.quoteFn(snap);
    const hard = await getWatchConfig(this.accountId).then((c) => c.hardPoints).catch(() => 0);
    const done = new Set<string>();
    for (const l of rows) {
      if (done.has(l.strategy_id)) continue;
      const mark = this.markOf(q(l.symbol));
      if (mark == null) continue;
      const closeSide: Side = l.side === 'sell' ? 'buy' : 'sell';
      const stop = Number(l.stop_price);
      // a sold leg is closed `hard` points BEFORE its stop; a bought leg `hard` points above it
      const early = closeSide === 'buy' ? stop - hard : stop + hard;
      if (!stopTriggered(closeSide, early, mark)) continue;
      done.add(l.strategy_id);
      const hit = stopTriggered(closeSide, stop, mark);
      await this.closeStrategyLegs(st, snap, l.strategy_id, hit
        ? `stop: ${l.symbol} reached ${mark.toFixed(1)}, its stop was ${stop.toFixed(1)}`
        : `stop: hard exit, ${l.symbol} at ${mark.toFixed(1)} was within ${hard} points of its stop ${stop.toFixed(1)}`);
    }
  }

  /** Strategies whose positions are gone (expired, settled, liquidated) are closed at their settlement or the mark. */
  private async syncStrategies(st: State, snap: MarketSnapshot): Promise<void> {
    const open = (await pool.query(`SELECT DISTINCT l.strategy_id FROM paper_strategy_legs l JOIN paper_strategies s ON s.id = l.strategy_id WHERE s.status = 'open' AND s.account_id = $1 AND l.exit_price IS NULL`, [this.accountId])).rows as any[];
    for (const r of open) {
      const legs = (await pool.query('SELECT symbol FROM paper_strategy_legs WHERE strategy_id = $1 AND exit_price IS NULL', [r.strategy_id])).rows as any[];
      if (legs.every((l) => !st.positions.has(l.symbol))) {
        const expired = legs.every((l) => (parseOptionSymbol(l.symbol)?.expiryMs ?? Infinity) <= Date.now());
        await this.closeStrategyLegs(st, snap, r.strategy_id, expired ? 'expired and settled' : 'positions were closed (liquidation or manual orders)');
      }
    }
  }

  /** Every open leg that has a stop, for the stop alarm. */
  async watchLegs(): Promise<WatchLeg[]> {
    if (this.idle) return [];
    const s = await this.strategies(0);
    const out: WatchLeg[] = [];
    for (const st of s.open) {
      for (const l of st.legs) {
        if (l.exit != null || l.stop == null) continue;
        out.push({ source: 'paper', group: st.id, groupLabel: st.name, symbol: l.symbol, side: l.side === 'sell' ? 'sold' : 'bought', entry: l.entry, mark: l.mark, stop: l.stop, lots: l.lots });
      }
    }
    return out;
  }

  /** Open strategies with live per-leg and net PnL, then the most recent closed ones. */
  strategies(closedLimit = 30) {
    return this.serial(async () => {
      await this.ensure();
      const ss = (await pool.query(
        `SELECT * FROM paper_strategies WHERE account_id = $2 AND status = 'open'
         UNION ALL (SELECT * FROM paper_strategies WHERE account_id = $2 AND status <> 'open' ORDER BY closed_at DESC LIMIT $1)`,
        [closedLimit, this.accountId],
      )).rows as any[];
      if (!ss.length) return { open: [], closed: [], marketError: null as string | null };
      const ids = ss.map((s) => `'${String(s.id).replace(/[^0-9a-f-]/gi, '')}'`).join(',');
      const ls = (await pool.query(`SELECT * FROM paper_strategy_legs WHERE strategy_id IN (${ids}) ORDER BY id`)).rows as any[];
      let snap: MarketSnapshot | null = null;
      let marketError: string | null = null;
      if (ss.some((s) => s.status === 'open')) {
        try { snap = await this.quick(); } catch (e) { marketError = (e as Error).message; }
      }
      const q = snap ? this.quoteFn(snap) : null;
      const out = ss.map((s) => {
        const legs = ls.filter((l) => l.strategy_id === s.id).map((l) => {
          const entry = Number(l.entry_price);
          const exit = l.exit_price == null ? null : Number(l.exit_price);
          const mark = exit == null && q ? this.markOf(q(l.symbol)) : null;
          const ref = exit ?? mark;
          const sign = l.side === 'buy' ? 1 : -1;
          const stop = l.stop_price == null ? null : Number(l.stop_price);
          const fee = Number(l.entry_fee) + Number(l.exit_fee);
          return {
            symbol: l.symbol, side: l.side as Side, lots: Number(l.lots), entry, mark, exit, stop, fee,
            pnl: ref == null ? null : sign * (ref - entry) * Number(l.lots) * 0.001,
            // how far the leg's price still has to move to hit its stop, as a share of the stop price
            stopDistancePct: exit == null && stop != null && mark != null && stop > 0 ? ((l.side === 'sell' ? stop - mark : mark - stop) / stop) * 100 : null,
          };
        });
        const known = legs.every((l) => l.pnl != null);
        const gross = known ? legs.reduce((a, l) => a + (l.pnl as number), 0) : null;
        const fees = legs.reduce((a, l) => a + l.fee, 0);
        return {
          id: s.id as string, name: s.name as string, status: s.status as string, openedAt: new Date(s.opened_at).getTime(),
          closedAt: s.closed_at ? new Date(s.closed_at).getTime() : null, closeReason: (s.close_reason ?? null) as string | null,
          marginAtEntry: Number(s.margin_at_entry), netPremium: Number(s.net_premium), legs, grossPnl: gross, fees, netPnl: gross == null ? null : gross - fees,
        };
      });
      return { open: out.filter((s) => s.status === 'open'), closed: out.filter((s) => s.status !== 'open'), marketError };
    });
  }

  // ---------- background evaluation ----------

  /** Settle expired options, trigger stops, fill resting limits, and liquidate if equity has collapsed. */
  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.idle) return;
      try {
        await this.ensure();
        const st = await this.load();
        if (!st.working.length && !st.positions.size) { this.idle = true; return; }
        const snap = await this.market.snapshot(1_500);
        this.lastTickAt = Date.now();
        await this.settleExpired(st, snap);
        await this.checkStops(st, snap);
        await this.runWorking(st, snap);
        await this.afterFills(st, snap);
        await this.syncStrategies(st, snap);
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as Error).message;
      }
    });
  }

  private async settleExpired(st: State, snap: MarketSnapshot): Promise<void> {
    const now = Date.now();
    for (const pos of [...st.positions.values()]) {
      const opt = parseOptionSymbol(pos.symbol);
      if (!opt || opt.expiryMs > now) continue;
      const px = intrinsicAtExpiry(opt.type, opt.strike, snap.spot);
      const { realized } = applyTrade(pos, -pos.lots, px, 0.001, 1, pos.symbol);
      const side: Side = pos.lots > 0 ? 'sell' : 'buy';
      const cash = st.cash + (side === 'sell' ? 1 : -1) * px * Math.abs(pos.lots) * 0.001;
      await pool.query(
        `INSERT INTO paper_fills (symbol, kind, side, lots, price, fee, maker, realized, note, account_id) VALUES ($1,'option',$2,$3,$4,0,false,$5,'expiry settlement at the index price',$6)`,
        [pos.symbol, side, Math.abs(pos.lots), px, realized, this.accountId],
      );
      await pool.query('DELETE FROM paper_positions WHERE symbol = $1 AND account_id = $2', [pos.symbol, this.accountId]);
      await pool.query(`UPDATE paper_account SET cash = $1, realized_total = realized_total + $2, updated_at = now() WHERE account_id = $3`, [cash, realized, this.accountId]);
      await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'contract expired', updated_at = now() WHERE symbol = $1 AND account_id = $2 AND status = 'working'`, [pos.symbol, this.accountId]);
      st.cash = cash;
      st.realizedTotal += realized;
      st.positions.delete(pos.symbol);
      st.working = st.working.filter((o) => o.symbol !== pos.symbol);
    }
  }

  private async runWorking(st: State, snap: MarketSnapshot): Promise<void> {
    const q = this.quoteFn(snap);
    for (const o of [...st.working]) {
      if (o.status !== 'working') continue;
      const inst = snap.insts.get(o.symbol);
      const quote = q(o.symbol);
      if (!inst || !quote) {
        await this.finish(o, 'cancelled', 'contract is no longer listed');
        continue;
      }
      if (o.reduceOnly) {
        const pos = st.positions.get(o.symbol);
        const closes = pos && ((pos.lots > 0 && o.side === 'sell') || (pos.lots < 0 && o.side === 'buy'));
        if (!closes) {
          await this.finish(o, 'cancelled', 'the position it would reduce is closed');
          continue;
        }
        const room = Math.abs(pos!.lots);
        if (o.lots - o.filledLots > room) {
          o.lots = o.filledLots + room;
          await pool.query('UPDATE paper_orders SET lots = $2, updated_at = now() WHERE id = $1', [o.id, o.lots]);
        }
      }
      const mark = quote.mark > 0 ? quote.mark : (quote.bid + quote.ask) / 2;
      const remaining = o.lots - o.filledLots;
      if (o.type === 'limit' && o.price != null && limitTradesThrough(o.side, o.price, quote)) {
        const leverage = o.leverage ?? st.positions.get(o.symbol)?.leverage ?? DEFAULT_LEVERAGE;
        const sim = this.simulate(st, inst, snap, o.side, remaining, o.price, true, leverage);
        if (!sim.ok) { await this.finish(o, 'cancelled', `would have filled, but ${sim.reason}`); continue; }
        await this.commit(st, o, inst, sim, remaining, o.price, true, o.price);
      } else if (o.type === 'stop_market' && o.stopPrice != null && stopTriggered(o.side, o.stopPrice, mark)) {
        const r = await this.takeFromBook(st, o, inst, snap);
        if (r.failed) await this.finish(o, 'cancelled', `stop triggered, but ${r.failed}`);
        else if (o.filledLots === 0) await this.finish(o, 'cancelled', 'stop triggered but the book had no liquidity');
        else if (r.left > 0) await this.finish(o, 'cancelled', `stop triggered; book depth filled ${o.filledLots} of ${o.lots} lots`);
      }
      if ((o.status as string) === 'filled' || o.filledLots > 0) await this.cancelSiblings(st, o, 'its bracket partner filled');
    }
    st.working = st.working.filter((o) => o.status === 'working');
  }

  /** Liquidate the whole account when equity is below the maintenance share of margin. */
  private async afterFills(st: State, snap: MarketSnapshot): Promise<void> {
    st.working = st.working.filter((o) => o.status === 'working');
    const v = this.view(st, st.positions.values(), snap);
    if (!shouldLiquidate(v)) return;
    await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'liquidation', updated_at = now() WHERE account_id = $1 AND status = 'working'`, [this.accountId]);
    st.working = [];
    const q = this.quoteFn(snap);
    for (const pos of [...st.positions.values()]) {
      const inst = snap.insts.get(pos.symbol);
      const quote = q(pos.symbol);
      if (!inst || !quote) continue;
      const px = quote.mark > 0 ? quote.mark : (quote.bid + quote.ask) / 2;
      const side: Side = pos.lots > 0 ? 'sell' : 'buy';
      const o: OrderRow = {
        id: randomUUID(), createdAt: Date.now(), symbol: pos.symbol, kind: inst.kind, side, type: 'market', lots: Math.abs(pos.lots), filledLots: 0, price: null, stopPrice: null,
        reduceOnly: true, leverage: null, status: 'working', avgPrice: null, fee: 0, reason: 'liquidation', ocoGroup: null, basketId: null,
      };
      await pool.query(
        `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, reduce_only, status, reason, account_id) VALUES ($1,$2,$3,$4,'market',$5,true,'working','liquidation',$6)`,
        [o.id, o.symbol, o.kind, o.side, o.lots, this.accountId],
      );
      const sim = this.simulate(st, inst, snap, side, o.lots, px, false, pos.leverage);
      await this.commit(st, o, inst, sim, o.lots, px, false, px, 'liquidation at the mark');
    }
  }

  // ---------- reads for the API ----------

  async orders(status: string | null, limit: number): Promise<OrderRow[]> {
    await ensurePaperSchema();
    const r = await pool.query(
      `SELECT * FROM paper_orders WHERE account_id = $3 AND lots > 0 AND ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id LIMIT $2`,
      [status, limit, this.accountId],
    );
    return (r.rows as any[]).map(mapOrder);
  }

  /**
   * PnL for the top of the Paper page, options and futures apart. Closed PnL is realised minus fees on every fill (so an entry fee counts the moment it is paid);
   * open PnL is the unrealised PnL of what is still held. Together they equal equity minus the starting balance, which is the Account PnL line.
   */
  async pnl() {
    const a: any = await this.account();
    await ensurePaperSchema();
    const now = Date.now();
    const dayStart = istMidnightMs(istDateKey(now));
    const r = await pool.query(
      `SELECT kind, COUNT(*) FILTER (WHERE realized <> 0)::int AS closes, COUNT(*) FILTER (WHERE realized <> 0 AND realized - fee > 0)::int AS wins,
              COALESCE(SUM(realized - fee), 0)::float AS total,
              COALESCE(SUM(realized - fee) FILTER (WHERE at >= to_timestamp($1 / 1000.0)), 0)::float AS today,
              COALESCE(SUM(realized - fee) FILTER (WHERE at >= to_timestamp($2 / 1000.0)), 0)::float AS week,
              COUNT(*) FILTER (WHERE realized <> 0 AND at >= to_timestamp($1 / 1000.0))::int AS today_closes
         FROM paper_fills WHERE account_id = $3 GROUP BY kind`,
      [dayStart, now - 7 * DAY, this.accountId],
    );
    const openStrategies = Number(((await pool.query(`SELECT COUNT(*)::int AS n FROM paper_strategies WHERE status = 'open' AND account_id = $1`, [this.accountId])).rows[0] as any)?.n ?? 0);
    const positions = (a.positions ?? []) as Array<{ kind: string; unrealized: number | null }>;
    const side = (fut: boolean) => {
      const row = (r.rows as any[]).find((x) => (x.kind === 'perp') === fut);
      const held = positions.filter((p) => (p.kind === 'perp') === fut);
      return {
        openCount: fut ? held.length : Math.max(openStrategies, held.length ? 1 : 0),
        openPnl: held.reduce((s, p) => s + (p.unrealized ?? 0), 0), openKnown: held.every((p) => p.unrealized != null),
        today: row ? Number(row.today) : 0, todayCloses: row ? Number(row.today_closes) : 0, week: row ? Number(row.week) : 0,
        total: row ? Number(row.total) : 0, closes: row ? Number(row.closes) : 0, wins: row ? Number(row.wins) : 0,
      };
    };
    const v = a.view;
    return {
      account: v ? { pnl: v.equity - a.account.startBalance, equity: v.equity, startBalance: a.account.startBalance, cash: a.account.cash, margin: v.margin, available: v.available } : null,
      options: side(false), futures: side(true), marketError: a.marketError ?? null,
    };
  }

  async fills(limit: number) {
    await ensurePaperSchema();
    const r = await pool.query('SELECT * FROM paper_fills WHERE account_id = $2 ORDER BY at DESC, id DESC LIMIT $1', [limit, this.accountId]);
    return (r.rows as any[]).map((f) => ({
      id: Number(f.id), at: new Date(f.at).getTime(), orderId: f.order_id, symbol: f.symbol, kind: f.kind, side: f.side, lots: Number(f.lots), price: Number(f.price),
      fee: Number(f.fee), maker: !!f.maker, slippageUsd: Number(f.slippage_usd), realized: Number(f.realized), note: f.note,
    }));
  }

  board(maxAgeMs = 3_000) {
    return this.market.snapshot(maxAgeMs);
  }

  /**
   * The chain for one expiry with, on every strike, the extra margin that SELLING `lots` of it would need on top of
   * what the account already carries (so a hedged sale shows its true, smaller requirement), and the premium for
   * buying or selling that size. Same margin mode as the account.
   */
  async boardWithMargin(lots: number, maxAgeMs = 3_000) {
    const snap = maxAgeMs >= 3_000 ? await this.quick() : await this.market.snapshot(maxAgeMs);
    let st: State | null = null;
    try { await this.ensure(); st = await this.load(); } catch { st = null; }
    const base = st ? this.view(st, st.positions.values(), snap) : null;
    const rowsOut = snap.rows.map((r) => {
      const inst = snap.insts.get(r.symbol);
      if (!st || !base || !inst) return { ...r, sellMargin: null as number | null, sellOk: null as boolean | null, buyCost: r.ask * lots * 0.001 };
      const cur = st.positions.get(r.symbol) ?? null;
      const price = r.bid > 0 ? r.bid : r.mark;
      const { pos: np } = applyTrade(cur, -lots, price, inst.contractValue, cur?.leverage ?? DEFAULT_LEVERAGE, r.symbol);
      const list = [...st.positions.values()].filter((p) => p.symbol !== r.symbol);
      if (np && np.lots !== 0) list.push(np);
      // cash moves by the premium received, which also counts toward what is available
      const cash = st.cash + cashDelta(inst, 'sell', lots, price, feeFor(inst, price, lots, snap.spot, false), 0);
      const v = this.view({ cash, start: st.start, mode: st.mode }, list, snap);
      const grows = Math.abs(np?.lots ?? 0) > Math.abs(cur?.lots ?? 0);
      return { ...r, sellMargin: Math.max(v.margin - base.margin, 0), sellOk: !grows || v.available >= 0, buyCost: r.ask * lots * inst.contractValue };
    });
    return { snap, rows: rowsOut, mode: st?.mode ?? 'portfolio', available: base?.available ?? null };
  }


  book(symbol: string) {
    return this.market.book(symbol);
  }
}

// One market feed for everybody (so ten users cost one Delta fetch every 3 s) and one PaperTerminal per account.
let sharedMarketFeed: DeltaMarket | null = null;
function sharedMarket(): DeltaMarket {
  return (sharedMarketFeed ??= new DeltaMarket());
}
const accounts = new Map<string, PaperTerminal>();
export function paperFor(userId: string): PaperTerminal {
  let t = accounts.get(userId);
  if (!t) accounts.set(userId, (t = new PaperTerminal(sharedMarket(), userId)));
  return t;
}
/** Every 5 seconds: only accounts that hold something are ticked, so stops, expiry and liquidation run for everyone, screen off. */
export async function tickAllPaper(): Promise<void> {
  await Promise.all([...accounts.values()].filter((a) => a.active).map((a) => a.tick()));
}
/** After a restart: find accounts with open positions, working orders or open strategies and wake them. */
export async function discoverActiveAccounts(): Promise<void> {
  await ensurePaperSchema();
  const r = await pool.query(
    `SELECT account_id FROM paper_positions UNION SELECT account_id FROM paper_orders WHERE status = 'working' UNION SELECT account_id FROM paper_strategies WHERE status = 'open'`,
  );
  for (const row of r.rows as Array<{ account_id: string }>) paperFor(row.account_id);
}
/** The accounts holding something right now (for the stop alarm), and one account if it exists. */
export const activePaperIds = (): string[] => [...accounts.entries()].filter(([, a]) => a.active).map(([id]) => id);
export const peekPaper = (userId: string): PaperTerminal | undefined => accounts.get(userId);
export const marketFeed = (): DeltaMarket => sharedMarket();
export const paperTerminal = paperFor(DESK_USER_ID);

export interface BasketLeg {
  symbol: string;
  side: Side;
  lots: number;
  /**
   * Stop price for this leg, on the option's own price. Left out: a sold option stops at 2x its sell price and a bought
   * option has no stop. null: no stop. When any leg's mark reaches its stop the whole strategy is closed.
   */
  stop?: number | null;
}

/** The default stop: 2x the sell price for a sold option, none for anything else. */
export const DEFAULT_STOP_MULT = 2;
