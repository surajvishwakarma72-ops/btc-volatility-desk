import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import {
  accountView, applyTrade, cashDelta, feeFor, intrinsicAtExpiry, limitTradesThrough, payoffSummary, roundToTick, shouldLiquidate, signed, stopTriggered,
  unrealized, validateOrder, walk, type AccountView, type Instrument, type MarginMode, type OrderReq, type PayoffLeg, type Position, type Quote, type Side,
} from '../../lib/bot/paper-terminal.js';
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

  constructor(private readonly market: MarketProvider = new DeltaMarket()) {}

  get enabled(): boolean {
    return process.env.PAPER_TERMINAL !== 'false';
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
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

  private async ensure(): Promise<void> {
    await ensurePaperSchema();
    await pool.query(
      `INSERT INTO paper_account (id, cash, start_balance) VALUES (1, $1, $1) ON CONFLICT (id) DO NOTHING`,
      [START_BALANCE],
    );
  }

  private async load(): Promise<State> {
    const [a, p, w] = await Promise.all([
      pool.query('SELECT * FROM paper_account WHERE id = 1'),
      pool.query('SELECT * FROM paper_positions'),
      pool.query(`SELECT * FROM paper_orders WHERE status = 'working' ORDER BY created_at, id`),
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
      `INSERT INTO paper_fills (order_id, symbol, kind, side, lots, price, fee, maker, slippage_usd, realized, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [o.id, sym, inst.kind, o.side, lots, price, sim.fee, maker, slip, sim.realized, note ?? null],
    );
    if (sim.newPos) {
      await pool.query(
        `INSERT INTO paper_positions (symbol, kind, lots, avg_entry, leverage, realized) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (symbol) DO UPDATE SET lots = EXCLUDED.lots, avg_entry = EXCLUDED.avg_entry, leverage = EXCLUDED.leverage, realized = EXCLUDED.realized,
           opened_at = CASE WHEN paper_positions.lots = 0 THEN now() ELSE paper_positions.opened_at END`,
        [sym, inst.kind, sim.newPos.lots, sim.newPos.avgEntry, sim.newPos.leverage, sim.newPos.realized],
      );
      st.positions.set(sym, sim.newPos);
    } else {
      await pool.query('DELETE FROM paper_positions WHERE symbol = $1', [sym]);
      st.positions.delete(sym);
    }
    await pool.query(
      `UPDATE paper_account SET cash = $1, realized_total = realized_total + $2, fees_total = fees_total + $3, updated_at = now() WHERE id = 1`,
      [sim.cashAfter, sim.realized, sim.fee],
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
          `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, price, stop_price, reduce_only, leverage, status, reason, oco_group)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [o.id, o.symbol, o.kind, o.side, o.type, o.lots, o.price, o.stopPrice, o.reduceOnly, o.leverage, o.status, o.reason, o.ocoGroup],
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
        `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, price, stop_price, reduce_only, leverage, status, reason, oco_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NULL,'working',$9,$10)`,
        [c.id, c.symbol, c.kind, c.side, c.type, c.lots, c.price, c.stopPrice, c.reason, c.ocoGroup],
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
      const r = await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled by you', updated_at = now() WHERE id = $1 AND status = 'working' RETURNING id, oco_group`, [id]);
      if (!r.rowCount) return false;
      const g = (r.rows[0] as any).oco_group;
      if (g) await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled with its bracket partner', updated_at = now() WHERE oco_group = $1 AND status = 'working'`, [g]);
      return true;
    });
  }

  cancelAll() {
    return this.serial(async () => {
      await this.ensure();
      const r = await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'cancelled by you', updated_at = now() WHERE status = 'working'`);
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
        await pool.query('UPDATE paper_positions SET leverage = $2 WHERE symbol = $1', [symbol, leverage]);
      }
      return { ok: true };
    });
  }

  reset(balance: number) {
    return this.serial(async () => {
      await ensurePaperSchema();
      await pool.query('DELETE FROM paper_fills; DELETE FROM paper_orders; DELETE FROM paper_positions; DELETE FROM paper_account;');
      await pool.query('INSERT INTO paper_account (id, cash, start_balance) VALUES (1, $1, $1)', [balance]);
    });
  }

  /** Account snapshot: balances, margin, positions with live PnL, and working orders. */
  account() {
    return this.serial(async () => {
      await this.ensure();
      const st = await this.load();
      let snap: MarketSnapshot | null = null;
      let marketError: string | null = null;
      try { snap = await this.market.snapshot(4_000); } catch (e) { marketError = (e as Error).message; }
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
        let liq: number | null = null;
        if (onlyPerp && inst?.kind === 'perp') {
          const L = Math.abs(p.lots) * cv;
          liq = p.lots > 0 ? (L * p.avgEntry - st.cash) / (L * (1 - 0.5 / p.leverage)) : (st.cash + L * p.avgEntry) / (L * (1 + 0.5 / p.leverage));
          if (!(liq > 0)) liq = null;
        }
        return {
          symbol: p.symbol, kind: inst?.kind ?? (p.symbol.includes('-') ? 'option' : 'perp'), lots: p.lots, avgEntry: p.avgEntry, leverage: p.leverage, mark,
          unrealized: upnl, realized: p.realized,
          margin: inst?.kind === 'perp' && mark != null ? (Math.abs(p.lots) * cv * mark) / p.leverage : null,
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
      await pool.query('UPDATE paper_account SET margin_mode = $1, updated_at = now() WHERE id = 1', [mode]);
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
  placeBasket(legs: BasketLeg[]) {
    return this.serial(async () => {
      this.idle = false;
      await this.ensure();
      const snap = await this.market.snapshot(2_000);
      const st = await this.load();
      const p = await this.planBasket(st, snap, legs);
      if (!('planned' in p) || !p.ok) return { ok: false, reason: p.reason ?? 'could not plan the strategy', orders: [] as OrderRow[] };
      const basketId = randomUUID();
      const orders: OrderRow[] = [];
      for (const leg of p.planned) {
        const o: OrderRow = {
          id: randomUUID(), createdAt: Date.now(), symbol: leg.inst.symbol, kind: leg.inst.kind, side: leg.side, type: 'market', lots: leg.lots, filledLots: 0,
          price: null, stopPrice: null, reduceOnly: false, leverage: null, status: 'working', avgPrice: null, fee: 0, reason: 'strategy leg', ocoGroup: null, basketId,
        };
        await pool.query(
          `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, reduce_only, status, reason, basket_id) VALUES ($1,$2,$3,$4,'market',$5,false,'working','strategy leg',$6)`,
          [o.id, o.symbol, o.kind, o.side, o.lots, basketId],
        );
        // the whole package was checked together above, so each leg is applied without a separate margin test
        const lev = st.positions.get(o.symbol)?.leverage ?? DEFAULT_LEVERAGE;
        const sim = this.simulate(st, leg.inst, snap, leg.side, leg.lots, leg.price, false, lev);
        await this.commit(st, o, leg.inst, sim, leg.lots, leg.price, false, leg.best, 'strategy leg');
        orders.push(o);
      }
      await this.afterFills(st, snap);
      return { ok: true, basketId, orders, netPremium: p.netPremium, fees: p.fees, payoff: p.payoff };
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
        await this.runWorking(st, snap);
        await this.afterFills(st, snap);
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
        `INSERT INTO paper_fills (symbol, kind, side, lots, price, fee, maker, realized, note) VALUES ($1,'option',$2,$3,$4,0,false,$5,'expiry settlement at the index price')`,
        [pos.symbol, side, Math.abs(pos.lots), px, realized],
      );
      await pool.query('DELETE FROM paper_positions WHERE symbol = $1', [pos.symbol]);
      await pool.query(`UPDATE paper_account SET cash = $1, realized_total = realized_total + $2, updated_at = now() WHERE id = 1`, [cash, realized]);
      await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'contract expired', updated_at = now() WHERE symbol = $1 AND status = 'working'`, [pos.symbol]);
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
    await pool.query(`UPDATE paper_orders SET status = 'cancelled', reason = 'liquidation', updated_at = now() WHERE status = 'working'`);
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
        `INSERT INTO paper_orders (id, symbol, kind, side, otype, lots, reduce_only, status, reason) VALUES ($1,$2,$3,$4,'market',$5,true,'working','liquidation')`,
        [o.id, o.symbol, o.kind, o.side, o.lots],
      );
      const sim = this.simulate(st, inst, snap, side, o.lots, px, false, pos.leverage);
      await this.commit(st, o, inst, sim, o.lots, px, false, px, 'liquidation at the mark');
    }
  }

  // ---------- reads for the API ----------

  async orders(status: string | null, limit: number): Promise<OrderRow[]> {
    await ensurePaperSchema();
    const r = await pool.query(
      `SELECT * FROM paper_orders WHERE lots > 0 AND ($1::text IS NULL OR status = $1) ORDER BY created_at DESC, id LIMIT $2`,
      [status, limit],
    );
    return (r.rows as any[]).map(mapOrder);
  }

  async fills(limit: number) {
    await ensurePaperSchema();
    const r = await pool.query('SELECT * FROM paper_fills ORDER BY at DESC, id DESC LIMIT $1', [limit]);
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
    const snap = await this.market.snapshot(maxAgeMs);
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

export const paperTerminal = new PaperTerminal();

export interface BasketLeg {
  symbol: string;
  side: Side;
  lots: number;
}
