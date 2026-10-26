/**
 * PnL analysis, in two parts: one trade's minute-by-minute series, and the run of all closed trades (equity curve, drawdown, the
 * statistics a trader reads). Pure functions over recorded numbers: nothing here estimates or invents a figure.
 */
export interface SeriesPoint {
  t: number;
  net: number;
  gross: number;
  spot: number | null;
  pct: number | null;
}

export interface SeriesStats {
  minutes: number;
  startMs: number | null;
  endMs: number | null;
  holdMin: number;
  first: number | null;
  last: number | null;
  peak: { net: number; t: number; atMin: number } | null;
  trough: { net: number; t: number; atMin: number } | null;
  /** Peak minus the last value: what was given back from the best moment. */
  gaveBack: number | null;
  /** Largest fall from a running high inside the trade. */
  maxDrawdown: { amount: number; fromT: number; toT: number } | null;
  /** Share of recorded minutes with a positive net PnL. */
  timeInProfitPct: number | null;
  /** Biggest one-minute move and the average size of a minute's move. */
  biggestMinute: { change: number; t: number } | null;
  avgAbsMinute: number | null;
  /** Minutes the trade went without a recorded mark (gaps in the recording). */
  gapMinutes: number;
}

const MIN = 60_000;

export function analyzeSeries(points: readonly SeriesPoint[]): SeriesStats {
  const p = points.filter((x) => Number.isFinite(x.net));
  if (!p.length) {
    return { minutes: 0, startMs: null, endMs: null, holdMin: 0, first: null, last: null, peak: null, trough: null, gaveBack: null, maxDrawdown: null, timeInProfitPct: null, biggestMinute: null, avgAbsMinute: null, gapMinutes: 0 };
  }
  const t0 = p[0]!.t;
  let peak = p[0]!, trough = p[0]!;
  let runHigh = p[0]!, dd: SeriesStats['maxDrawdown'] = null;
  let inProfit = 0, big: SeriesStats['biggestMinute'] = null, absSum = 0, gap = 0;
  for (let i = 0; i < p.length; i++) {
    const x = p[i]!;
    if (x.net > peak.net) peak = x;
    if (x.net < trough.net) trough = x;
    if (x.net > runHigh.net) runHigh = x;
    const fall = runHigh.net - x.net;
    if (fall > 0 && (!dd || fall > dd.amount)) dd = { amount: fall, fromT: runHigh.t, toT: x.t };
    if (x.net > 0) inProfit++;
    if (i > 0) {
      const prev = p[i - 1]!, ch = x.net - prev.net;
      absSum += Math.abs(ch);
      if (!big || Math.abs(ch) > Math.abs(big.change)) big = { change: ch, t: x.t };
      const missing = Math.round((x.t - prev.t) / MIN) - 1;
      if (missing > 0) gap += missing;
    }
  }
  const last = p[p.length - 1]!;
  return {
    minutes: p.length, startMs: t0, endMs: last.t, holdMin: Math.round((last.t - t0) / MIN),
    first: p[0]!.net, last: last.net,
    peak: { net: peak.net, t: peak.t, atMin: Math.round((peak.t - t0) / MIN) },
    trough: { net: trough.net, t: trough.t, atMin: Math.round((trough.t - t0) / MIN) },
    gaveBack: peak.net - last.net, maxDrawdown: dd,
    timeInProfitPct: (inProfit / p.length) * 100, biggestMinute: big, avgAbsMinute: p.length > 1 ? absSum / (p.length - 1) : null, gapMinutes: gap,
  };
}

export interface TradeRec {
  id: string;
  strategy: string;
  book: string;
  dateKey: string;
  entryMs: number;
  exitMs: number;
  net: number;
  gross: number;
  fees: number;
  margin: number | null;
  reason: string | null;
}

export interface EquityPoint {
  n: number;
  id: string;
  strategy: string;
  dateKey: string;
  exitMs: number;
  net: number;
  cum: number;
  /** Below the running high of the cumulative curve (zero at a new high). */
  dd: number;
  reason: string | null;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netTotal: number;
  grossTotal: number;
  feesTotal: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Average win divided by the size of the average loss. */
  payoff: number | null;
  /** Gross profit divided by gross loss; null when there is no loss yet. */
  profitFactor: number | null;
  expectancy: number | null;
  best: TradeRec | null;
  worst: TradeRec | null;
  maxDrawdown: { amount: number; fromN: number; toN: number } | null;
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldMin: number | null;
  avgReturnOnMargin: number | null;
  byStrategy: Array<{ strategy: string; trades: number; net: number; winRate: number }>;
}

export function analyzeTrades(trades: readonly TradeRec[]): { equity: EquityPoint[]; stats: TradeStats } {
  const t = trades.slice().sort((a, b) => a.exitMs - b.exitMs);
  const equity: EquityPoint[] = [];
  let cum = 0, high = 0;
  let dd: TradeStats['maxDrawdown'] = null, highN = 0;
  t.forEach((x, i) => {
    cum += x.net;
    if (cum > high) { high = cum; highN = i + 1; }
    const d = high - cum;
    if (d > 0 && (!dd || d > dd.amount)) dd = { amount: d, fromN: highN, toN: i + 1 };
    equity.push({ n: i + 1, id: x.id, strategy: x.strategy, dateKey: x.dateKey, exitMs: x.exitMs, net: x.net, cum, dd: d, reason: x.reason });
  });
  const wins = t.filter((x) => x.net > 0), losses = t.filter((x) => x.net < 0);
  const sum = (a: readonly TradeRec[], f: (x: TradeRec) => number) => a.reduce((s, x) => s + f(x), 0);
  const gp = sum(wins, (x) => x.net), gl = Math.abs(sum(losses, (x) => x.net));
  let ws = 0, ls = 0, bw = 0, bl = 0;
  for (const x of t) {
    if (x.net > 0) { ws++; ls = 0; } else if (x.net < 0) { ls++; ws = 0; } else { ws = 0; ls = 0; }
    bw = Math.max(bw, ws); bl = Math.max(bl, ls);
  }
  const rom = t.filter((x) => x.margin && x.margin > 0).map((x) => x.net / x.margin!);
  const by = new Map<string, TradeRec[]>();
  for (const x of t) (by.get(x.strategy) ?? by.set(x.strategy, []).get(x.strategy)!).push(x);
  const avgWin = wins.length ? gp / wins.length : null, avgLoss = losses.length ? -gl / losses.length : null;
  return {
    equity,
    stats: {
      trades: t.length, wins: wins.length, losses: losses.length, winRate: t.length ? wins.length / t.length : null,
      netTotal: sum(t, (x) => x.net), grossTotal: sum(t, (x) => x.gross), feesTotal: sum(t, (x) => x.fees),
      avgWin, avgLoss, payoff: avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
      profitFactor: gl > 0 ? gp / gl : null, expectancy: t.length ? sum(t, (x) => x.net) / t.length : null,
      best: t.length ? t.reduce((a, b) => (b.net > a.net ? b : a)) : null, worst: t.length ? t.reduce((a, b) => (b.net < a.net ? b : a)) : null,
      maxDrawdown: dd, longestWinStreak: bw, longestLossStreak: bl,
      avgHoldMin: t.length ? sum(t, (x) => (x.exitMs - x.entryMs) / MIN) / t.length : null,
      avgReturnOnMargin: rom.length ? rom.reduce((a, b) => a + b, 0) / rom.length : null,
      byStrategy: [...by.entries()].map(([strategy, a]) => ({ strategy, trades: a.length, net: sum(a, (x) => x.net), winRate: a.filter((x) => x.net > 0).length / a.length })).sort((a, b) => b.net - a.net),
    },
  };
}
