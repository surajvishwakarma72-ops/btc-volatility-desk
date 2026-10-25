/** Portfolio-level guard applied before every order, above the per-strategy rules. */

export interface RiskLimits {
  maxOpenMarginUsd: number;
  maxOpenPositions: number;
  maxDailyLossUsd: number;
  maxMonthlyLossUsd: number;
}

export interface PortfolioState {
  openMarginUsd: number;
  openPositions: number;
  /** Realised + unrealised PnL since IST midnight (negative = loss). */
  dailyPnlUsd: number;
  monthlyPnlUsd: number;
  /** Manually or automatically paused. */
  paused: boolean;
  killSwitch: boolean;
}

export interface OrderIntent {
  strategy: string;
  marginUsd: number;
  /** Short-volatility structures are blocked or shrunk by the event rule. */
  shortVol: boolean;
}

export interface GuardContext {
  /** A high-impact event (CPI/FOMC) is inside the hold window. */
  eventInWindow: boolean;
}

export interface GuardResult {
  allowed: boolean;
  reasons: string[];
}

export function checkRisk(
  intent: OrderIntent,
  state: PortfolioState,
  limits: RiskLimits,
  ctx: GuardContext,
): GuardResult {
  const reasons: string[] = [];
  if (state.killSwitch) reasons.push('kill switch is on');
  if (state.paused) reasons.push('bot is paused');
  if (state.openPositions >= limits.maxOpenPositions) {
    reasons.push(`open positions ${state.openPositions} at limit ${limits.maxOpenPositions}`);
  }
  if (state.openMarginUsd + intent.marginUsd > limits.maxOpenMarginUsd) {
    reasons.push(
      `margin ${(state.openMarginUsd + intent.marginUsd).toFixed(0)} would exceed ${limits.maxOpenMarginUsd.toFixed(0)}`,
    );
  }
  if (state.dailyPnlUsd <= -limits.maxDailyLossUsd) reasons.push('daily loss limit reached');
  if (state.monthlyPnlUsd <= -limits.maxMonthlyLossUsd) reasons.push('monthly loss limit reached');
  if (intent.shortVol && ctx.eventInWindow) reasons.push('high-impact event inside the hold window');
  return { allowed: reasons.length === 0, reasons };
}
