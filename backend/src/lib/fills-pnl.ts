/**
 * Realised P&L built from exchange fills. Pure.
 *
 * Uses only fields the Delta docs list: id, side, size, price, commission, role, created_at, fill_type, product_symbol, product.contract_value.
 * `commission` is taken as charged. The docs do not say whether it includes GST, so it is not split out or added to.
 * `meta_data.new_position.realized_pnl` is not used: the docs do not define it.
 */
export interface FillRow {
  exchangeFillId: string;
  symbol: string;
  instrument: 'option' | 'perp';
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  liquidity: string | null;
  filledAt: string;
  contractValue: number | null;
  fillType: string | null;
  raw: unknown;
}

const OPTION = /^[CP]-[A-Z]+-\d+(\.\d+)?-\d{6}$/;

/** Only BTC has a known lot to fall back on. Any other asset without one stays unpriced rather than guessed. */
function contractValueOf(raw: any, symbol: string): number | null {
  const cv = Number(raw?.product?.contract_value);
  if (cv > 0) return cv;
  return symbol.includes('-BTC-') || symbol === 'BTCUSD' ? 0.001 : null;
}

export function parseDeltaFill(raw: any): FillRow | null {
  const symbol = String(raw?.product_symbol ?? raw?.product?.symbol ?? '');
  const side = String(raw?.side ?? '').toLowerCase();
  const qty = Math.abs(Number(raw?.size));
  const price = Number(raw?.price);
  const at = Date.parse(raw?.created_at);
  if (raw?.id == null || !symbol || (side !== 'buy' && side !== 'sell') || !(qty > 0) || !Number.isFinite(price) || !Number.isFinite(at)) return null;
  const fee = Number(raw?.commission);
  return {
    exchangeFillId: String(raw.id),
    symbol,
    instrument: OPTION.test(symbol) ? 'option' : 'perp',
    side,
    qty,
    price,
    fee: Number.isFinite(fee) ? fee : 0,
    liquidity: raw?.role == null ? null : String(raw.role),
    filledAt: new Date(at).toISOString(),
    contractValue: contractValueOf(raw, symbol),
    fillType: raw?.fill_type == null ? null : String(raw.fill_type),
    raw,
  };
}

export interface LedgerResult {
  /** Net realised P&L of each fill after its fee, or null when it cannot be priced. */
  pnl: Map<string, number | null>;
  /** Signed open size per symbol, from fills alone. */
  open: Map<string, number>;
}

/** Walks one account's fills in time order, using average cost per symbol. */
export function ledger(fills: readonly Pick<FillRow, 'exchangeFillId' | 'symbol' | 'side' | 'qty' | 'price' | 'fee' | 'contractValue'>[]): LedgerResult {
  const book = new Map<string, { size: number; avg: number }>();
  const pnl = new Map<string, number | null>();
  for (const f of fills) {
    const pos = book.get(f.symbol) ?? { size: 0, avg: 0 };
    const signed = f.side === 'buy' ? f.qty : -f.qty;
    const closing = pos.size !== 0 && Math.sign(pos.size) !== Math.sign(signed) ? Math.min(Math.abs(pos.size), f.qty) : 0;
    const opening = f.qty - closing;
    const realised = closing * (pos.size > 0 ? f.price - pos.avg : pos.avg - f.price);
    if (opening > 0) {
      const held = closing > 0 ? 0 : Math.abs(pos.size);
      pos.avg = (held * pos.avg + opening * f.price) / (held + opening);
    }
    pos.size += signed;
    if (pos.size === 0) pos.avg = 0;
    book.set(f.symbol, pos);
    pnl.set(f.exchangeFillId, f.contractValue == null ? null : realised * f.contractValue - f.fee);
  }
  const open = new Map<string, number>();
  for (const [symbol, p] of book) if (p.size !== 0) open.set(symbol, p.size);
  return { pnl, open };
}

/** Symbols where the exchange's position and the fills disagree. */
export function positionDiffs(fromFills: ReadonlyMap<string, number>, exchange: ReadonlyMap<string, number>): string[] {
  return [...new Set([...fromFills.keys(), ...exchange.keys()])].filter((s) => (fromFills.get(s) ?? 0) !== (exchange.get(s) ?? 0)).sort();
}
