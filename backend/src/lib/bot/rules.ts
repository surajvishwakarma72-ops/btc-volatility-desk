import type { ExitConfig, ExitDecision, PnlBreakdown, PositionSnapshot } from './types.js';

/**
 * Mark-to-market PnL for a multi-leg position. Option prices are USD per 1 BTC underlying;
 * a lot is `contractValue` BTC (0.001), so per-leg PnL is price move x lots x contractValue.
 */
export function computePnl(p: PositionSnapshot): PnlBreakdown {
  const markOf = new Map(p.marks.map((m) => [m.symbol, m.mark]));
  const perLeg = p.legs.map((leg) => {
    const mark = markOf.get(leg.symbol) ?? leg.entryPrice;
    const move = leg.side === 'short' ? leg.entryPrice - mark : mark - leg.entryPrice;
    return { symbol: leg.symbol, pnl: move * leg.lots * p.contractValue };
  });
  const grossPnl = perLeg.reduce((s, l) => s + l.pnl, 0);
  const netPnl = grossPnl - p.feesPaidUsd;
  const pctOfMargin = p.marginUsd > 0 ? netPnl / p.marginUsd : 0;
  return { grossPnl, netPnl, pctOfMargin, perLeg };
}

/**
 * Pure exit decision. Priority: stop (risk) > hard safety close > breakeven > stop-loss on
 * margin > take profit > time exit. "One stop closes ALL" is enforced by returning a single
 * exit decision for the whole position; the caller closes every leg.
 */
export function evaluateExit(p: PositionSnapshot, cfg: ExitConfig, nowMs: number): ExitDecision {
  const pnl = computePnl(p);
  const markOf = new Map(p.marks.map((m) => [m.symbol, m.mark]));

  if (cfg.stopMultiple != null) {
    for (const leg of p.legs) {
      if (leg.side !== 'short' || leg.role !== 'body') continue;
      const mark = markOf.get(leg.symbol);
      const stop = leg.entryPrice * cfg.stopMultiple, hard = Math.max(0, cfg.hardPoints ?? 0);
      if (mark != null && mark >= stop - hard) {
        return {
          action: 'exit',
          reason: 'stop',
          detail: mark >= stop
            ? `${leg.symbol} mark ${mark.toFixed(2)} reached ${cfg.stopMultiple}x entry ${leg.entryPrice.toFixed(2)}`
            : `hard exit: ${leg.symbol} mark ${mark.toFixed(2)} was within ${hard} points of its stop ${stop.toFixed(2)} (${cfg.stopMultiple}x entry ${leg.entryPrice.toFixed(2)})`,
        };
      }
    }
  }

  if (cfg.hardCloseAtMs != null && nowMs >= cfg.hardCloseAtMs) {
    return { action: 'exit', reason: 'hard_close', detail: 'safety close before the sold front expiry' };
  }

  if (cfg.breakeven && (p.spot < cfg.breakeven.low || p.spot > cfg.breakeven.high)) {
    return {
      action: 'exit',
      reason: 'breakeven',
      detail: `spot ${p.spot.toFixed(0)} left breakeven band ${cfg.breakeven.low.toFixed(0)}-${cfg.breakeven.high.toFixed(0)}`,
    };
  }

  if (cfg.slPctOfMargin != null && pnl.pctOfMargin <= -cfg.slPctOfMargin) {
    return {
      action: 'exit',
      reason: 'sl',
      detail: `loss ${(pnl.pctOfMargin * 100).toFixed(1)}% of margin hit -${(cfg.slPctOfMargin * 100).toFixed(0)}%`,
    };
  }

  if (cfg.tpPctOfMargin != null && pnl.pctOfMargin >= cfg.tpPctOfMargin) {
    return {
      action: 'exit',
      reason: 'tp',
      detail: `profit ${(pnl.pctOfMargin * 100).toFixed(1)}% of margin hit +${(cfg.tpPctOfMargin * 100).toFixed(0)}%`,
    };
  }

  if (cfg.exitAtMs != null && nowMs >= cfg.exitAtMs) {
    return { action: 'exit', reason: 'time', detail: 'scheduled time exit' };
  }

  return { action: 'hold' };
}

/** Exit configuration per strategy (single source of truth, mirrors the approved plan). */
export function exitConfigFor(
  id: 'ASIA_SHORT' | 'NY_SHORT' | 'EVE_LONG' | 'PRE_LONG',
  exitAtMs: number,
  /** Learned overrides for the short strangles (the auto-learn champion); long straddles ignore them. */
  learned?: { stopMultiple?: number; tpPct?: number },
): ExitConfig {
  switch (id) {
    case 'ASIA_SHORT':
    case 'NY_SHORT':
      return { stopMultiple: learned?.stopMultiple ?? 2, tpPctOfMargin: learned?.tpPct ?? 0.1, exitAtMs };
    case 'EVE_LONG':
    case 'PRE_LONG':
      return { slPctOfMargin: 0.1, tpPctOfMargin: 0.5, exitAtMs };
  }
}

/** Breakeven band for a calendar from its net debit/credit-implied points (computed at entry). */
export function calendarExitConfig(
  breakeven: { low: number; high: number },
  frontExpiryMs: number,
): ExitConfig {
  return {
    tpPctOfMargin: 0.1,
    breakeven,
    hardCloseAtMs: frontExpiryMs - 3_600_000,
  };
}
