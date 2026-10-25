/**
 * Pure analytics over completed runs. The same code summarises historical replay runs and live
 * paper runs, so the two can be compared directly.
 */
export interface RunRecord {
  strategy: string;
  book: string;
  dateKey: string;
  weekday: number;
  entryMs: number;
  exitMs: number;
  entryIv: number | null;
  dvol: number | null;
  gateGo: boolean | null;
  marginUsd: number;
  feesUsd: number;
  netPnl: number;
  exitReason: string;
  peakPnl: number;
  troughPnl: number;
  path: Array<[number, number]>;
}

export interface GroupStats {
  key: string;
  trades: number;
  netPnl: number;
  avgPnl: number;
  medianPnl: number;
  winRate: number;
  stopRate: number;
  tpRate: number;
  avgWin: number;
  avgLoss: number;
  expectancyPerMarginPct: number;
  maxDrawdown: number;
  worstTrade: number;
  bestTrade: number;
  fees: number;
  avgGiveBack: number;
  sharpe: number | null;
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function groupStats(key: string, runs: RunRecord[]): GroupStats {
  const n = runs.length;
  const pnl = runs.map((r) => r.netPnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const ordered = [...runs].sort((a, b) => a.exitMs - b.exitMs);
  let eq = 0;
  let top = 0;
  let dd = 0;
  for (const r of ordered) {
    eq += r.netPnl;
    top = Math.max(top, eq);
    dd = Math.max(dd, top - eq);
  }
  const mean = n ? sum(pnl) / n : 0;
  const sd = n > 1 ? Math.sqrt(sum(pnl.map((p) => (p - mean) ** 2)) / (n - 1)) : 0;
  return {
    key,
    trades: n,
    netPnl: sum(pnl),
    avgPnl: mean,
    medianPnl: median(pnl),
    winRate: n ? wins.length / n : 0,
    stopRate: n ? runs.filter((r) => r.exitReason === 'stop').length / n : 0,
    tpRate: n ? runs.filter((r) => r.exitReason === 'tp' || r.exitReason === 'target').length / n : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    expectancyPerMarginPct: n ? sum(runs.map((r) => (r.marginUsd > 0 ? r.netPnl / r.marginUsd : 0))) / n : 0,
    maxDrawdown: dd,
    worstTrade: n ? Math.min(...pnl) : 0,
    bestTrade: n ? Math.max(...pnl) : 0,
    fees: sum(runs.map((r) => r.feesUsd)),
    avgGiveBack: n ? sum(runs.map((r) => Math.max(r.peakPnl - r.netPnl, 0))) / n : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : null,
  };
}

export function groupBy(runs: RunRecord[], keyFn: (r: RunRecord) => string): GroupStats[] {
  const m = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = keyFn(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return [...m.entries()].map(([k, v]) => groupStats(k, v)).sort((a, b) => a.key.localeCompare(b.key));
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ivBand(iv: number | null): string {
  if (iv == null) return 'n/a';
  if (iv < 30) return '<30';
  if (iv < 40) return '30-40';
  if (iv < 50) return '40-50';
  if (iv < 60) return '50-60';
  return '60+';
}

/** ISO-like week key (Monday-start) for an IST date key. */
export function weekKey(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/**
 * What-if exit grid: for each strategy, the average net PnL if every run had been closed at a
 * fixed time after entry (clamped to its real exit) instead of its real rule. This is how you see
 * whether a different time exit would have beaten the one in use.
 */
export function exitGrid(runs: RunRecord[], offsetsMin: number[]): Array<{ strategy: string; book: string; actual: number; points: Array<{ offsetMin: number; avgPnl: number; winRate: number }> }> {
  const by = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = `${r.strategy}|${r.book}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const at = (path: Array<[number, number]>, off: number): number => {
    let v = path[0]?.[1] ?? 0;
    for (const [m, p] of path) {
      if (m > off) break;
      v = p;
    }
    return v;
  };
  return [...by.entries()].map(([k, rs]) => {
    const [strategy, book] = k.split('|') as [string, string];
    return {
      strategy,
      book,
      actual: rs.reduce((s, r) => s + r.netPnl, 0) / rs.length,
      points: offsetsMin.map((off) => {
        const vals = rs.map((r) => at(r.path, off));
        return { offsetMin: off, avgPnl: vals.reduce((s, x) => s + x, 0) / vals.length, winRate: vals.filter((x) => x > 0).length / vals.length };
      }),
    };
  });
}

/** Average PnL curve (by minutes since entry) per strategy/book, for the Bot page chart. */
export function avgCurves(runs: RunRecord[], stepMin = 15): Array<{ strategy: string; book: string; points: Array<[number, number, number]> }> {
  const by = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = `${r.strategy}|${r.book}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  return [...by.entries()].map(([k, rs]) => {
    const [strategy, book] = k.split('|') as [string, string];
    const maxOff = Math.max(...rs.map((r) => r.path[r.path.length - 1]?.[0] ?? 0));
    const points: Array<[number, number, number]> = [];
    for (let off = 0; off <= maxOff; off += stepMin) {
      const vals = rs
        .map((r) => {
          const last = r.path[r.path.length - 1]!;
          if (off > last[0]) return last[1]; // closed: PnL stays at its final value
          let v = r.path[0]![1];
          for (const [m, p] of r.path) { if (m > off) break; v = p; }
          return v;
        })
        .sort((a, b) => a - b);
      points.push([off, vals.reduce((s, x) => s + x, 0) / vals.length, vals[vals.length >> 1]!]);
    }
    return { strategy, book, points };
  });
}

export function buildAnalytics(runs: RunRecord[]) {
  return {
    // The gated book trades the SAME trades as the always book on the days its gate says GO, so adding both would count
    // those trades twice. Totals use every trade of the always book (and the futures); the gated book keeps its own rows
    // in byStrategy as "the same trades, only when the gate said GO".
    totals: groupStats('all', runs.filter((r) => r.book !== 'gated')),
    byStrategy: groupBy(runs, (r) => `${r.strategy}|${r.book}`),
    byWeekday: groupBy(runs, (r) => `${r.strategy}|${r.book}|${WD[r.weekday]}`),
    byMonth: groupBy(runs, (r) => `${r.strategy}|${r.book}|${r.dateKey.slice(0, 7)}`),
    byWeek: groupBy(runs, (r) => `${r.strategy}|${r.book}|${weekKey(r.dateKey)}`),
    byIvBand: groupBy(runs, (r) => `${r.strategy}|${r.book}|${ivBand(r.entryIv)}`),
    byGate: groupBy(runs, (r) => `${r.strategy}|${r.book}|${r.gateGo == null ? 'n/a' : r.gateGo ? 'GO' : 'WAIT'}`),
    byExit: groupBy(runs, (r) => `${r.strategy}|${r.book}|${r.exitReason}`),
    exitGrid: exitGrid(runs, [30, 60, 120, 180, 240, 360, 480, 720, 1080, 1440]),
    curves: avgCurves(runs),
  };
}

export type Analytics = ReturnType<typeof buildAnalytics>;
