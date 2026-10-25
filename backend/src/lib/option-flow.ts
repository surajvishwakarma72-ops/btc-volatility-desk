/**
 * Option flow: what traders actually did in BTC options (Deribit prints), summarised by strike and by window.
 * Pure helpers; the service fetches the trades. Flow describes past trades, it does not predict anything.
 */
export interface DeribitTrade {
  instrument_name: string;
  direction: 'buy' | 'sell';
  /** Size in BTC. */
  amount: number;
  /** Premium per BTC, quoted in BTC. */
  price: number;
  index_price?: number;
  iv?: number;
  timestamp: number;
  block_trade_id?: string | null;
}

export interface ParsedInstrument {
  type: 'call' | 'put';
  strike: number;
  expiry: string;
}

/** BTC-28OCT26-80000-C -> { call, 80000, 28OCT26 } */
export function parseDeribitInstrument(name: string): ParsedInstrument | null {
  const m = /^BTC-([0-9]{1,2}[A-Z]{3}[0-9]{2})-([0-9]+)-([CP])$/.exec(name);
  if (!m) return null;
  return { type: m[3] === 'C' ? 'call' : 'put', strike: Number(m[2]), expiry: m[1]! };
}

export interface SideFlow {
  /** BTC bought and sold (the aggressor's side, as Deribit reports it). */
  buy: number;
  sell: number;
  trades: number;
  /** Premium traded in USD. */
  premiumUsd: number;
}

export interface StrikeFlow {
  strike: number;
  call: SideFlow;
  put: SideFlow;
}

export interface BigTrade {
  at: number;
  instrument: string;
  direction: 'buy' | 'sell';
  amount: number;
  iv: number | null;
  premiumUsd: number;
  block: boolean;
}

const empty = (): SideFlow => ({ buy: 0, sell: 0, trades: 0, premiumUsd: 0 });

export const BIG_TRADE_BTC = 10;

/** Per-strike flow over the last `hours`, and the biggest prints, from raw trades. */
export function summariseTrades(trades: readonly DeribitTrade[], nowMs: number, hours: number): { strikes: StrikeFlow[]; big: BigTrade[]; totals: { call: SideFlow; put: SideFlow } } {
  const since = nowMs - hours * 3_600_000;
  const by = new Map<number, StrikeFlow>();
  const totals = { call: empty(), put: empty() };
  const big: BigTrade[] = [];
  for (const t of trades) {
    if (!(t.timestamp >= since) || !(t.amount > 0)) continue;
    const p = parseDeribitInstrument(t.instrument_name);
    if (!p) continue;
    const row = by.get(p.strike) ?? by.set(p.strike, { strike: p.strike, call: empty(), put: empty() }).get(p.strike)!;
    const side = row[p.type];
    const usd = t.price * t.amount * (t.index_price ?? 0);
    const tot = totals[p.type];
    for (const s of [side, tot]) {
      if (t.direction === 'buy') s.buy += t.amount;
      else s.sell += t.amount;
      s.trades++;
      s.premiumUsd += usd;
    }
    if (t.amount >= BIG_TRADE_BTC || t.block_trade_id) {
      big.push({ at: t.timestamp, instrument: t.instrument_name, direction: t.direction, amount: t.amount, iv: t.iv ?? null, premiumUsd: usd, block: !!t.block_trade_id });
    }
  }
  return {
    strikes: [...by.values()].sort((a, b) => a.strike - b.strike),
    big: big.sort((a, b) => b.premiumUsd - a.premiumUsd).slice(0, 8),
    totals,
  };
}

export interface BucketSums {
  callBuy: number;
  callSell: number;
  putBuy: number;
  putSell: number;
  blockVol: number;
  trades: number;
}

/**
 * A plain-language read of a window, strictly about what was traded. "Bought" and "sold" are the aggressor's side,
 * so heavy call buying is people paying up for upside, not a forecast.
 */
export function describeFlow(s: BucketSums): string {
  const total = s.callBuy + s.callSell + s.putBuy + s.putSell;
  if (total <= 0) return 'No option trades recorded in this window.';
  const calls = s.callBuy + s.callSell;
  const puts = s.putBuy + s.putSell;
  const callNet = s.callBuy - s.callSell;
  const putNet = s.putBuy - s.putSell;
  const parts: string[] = [];
  parts.push(`${Math.round((calls / total) * 100)}% of volume was calls, ${Math.round((puts / total) * 100)}% puts`);
  const lean = (net: number, vol: number) => (vol <= 0 ? 'balanced' : Math.abs(net) / vol < 0.15 ? 'balanced' : net > 0 ? 'mostly bought' : 'mostly sold');
  parts.push(`calls ${lean(callNet, calls)}, puts ${lean(putNet, puts)}`);
  if (s.blockVol > 0) parts.push(`${s.blockVol.toFixed(0)} BTC in blocks`);
  return parts.join('; ') + '.';
}
