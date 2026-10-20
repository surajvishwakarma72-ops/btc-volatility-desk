export interface SeqTrade {
  trade_seq: number;
  [k: string]: unknown;
}

/**
 * Keep only trades with trade_seq strictly greater than the prior watermark.
 * Returns the fresh trades and the new watermark (max seq seen).
 */
export function filterNewTrades<T extends SeqTrade>(
  trades: T[],
  lastSeq: number | null,
): { fresh: T[]; maxSeq: number } {
  let maxSeq = lastSeq ?? -Infinity;
  const fresh: T[] = [];
  for (const t of trades) {
    const seq = Number(t.trade_seq);
    if (!Number.isFinite(seq)) continue;
    if (lastSeq == null || seq > lastSeq) fresh.push(t);
    if (seq > maxSeq) maxSeq = seq;
  }
  return { fresh, maxSeq: Number.isFinite(maxSeq) ? maxSeq : (lastSeq ?? 0) };
}

/** Signed percentage change between a previous and current value, or null if no previous. */
export function computeIvChangePct(prev: number | null, curr: number | null): number | null {
  if (prev == null || curr == null || !(prev > 0)) return null;
  return ((curr - prev) / prev) * 100;
}
