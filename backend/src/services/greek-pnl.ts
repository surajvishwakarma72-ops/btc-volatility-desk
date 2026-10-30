/**
 * Greek P&L Attribution Service (Task T2.3)
 *
 * Implements exact Greek P&L attribution formulas per Section 5.1 of the Execution Plan:
 *   delta_pnl   = quantity * contract_value * delta * delta_spot
 *   gamma_pnl   = 0.5 * quantity * contract_value * gamma * (delta_spot ** 2)
 *   theta_pnl   = theta * (elapsed_seconds / 86400)
 *   vega_pnl    = vega * delta_vol * 100
 *   other_pnl   = total_pnl - delta_pnl - gamma_pnl - theta_pnl - vega_pnl
 */

export interface PositionInput {
  symbol?: string;
  quantity: number;
  contract_value?: number; // usually 0.001 BTC per contract on Delta
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  delta_spot?: number;
  delta_vol?: number;
  elapsed_seconds: number;
  total_pnl: number;
  // Optional convenience fields if caller supplies raw spots / IVs
  current_spot?: number;
  entry_spot?: number;
  current_iv?: number;
  entry_iv?: number;
}

export interface GreekPnlResult {
  symbol?: string;
  delta_pnl: number;
  gamma_pnl: number;
  theta_pnl: number;
  vega_pnl: number;
  other_pnl: number;
  total_pnl: number;
}

/**
 * Compute the 5-component Greek P&L attribution for a position.
 */
export function computeGreekPnl(position: PositionInput): GreekPnlResult {
  const quantity = Number(position.quantity) || 0;
  const contract_value = position.contract_value !== undefined ? Number(position.contract_value) : 0.001;
  const delta = Number(position.delta) || 0;
  const gamma = Number(position.gamma) || 0;
  const theta = Number(position.theta) || 0;
  const vega = Number(position.vega) || 0;

  const delta_spot = position.delta_spot !== undefined
    ? Number(position.delta_spot)
    : (position.current_spot !== undefined && position.entry_spot !== undefined
        ? Number(position.current_spot) - Number(position.entry_spot)
        : 0);

  const delta_vol = position.delta_vol !== undefined
    ? Number(position.delta_vol)
    : (position.current_iv !== undefined && position.entry_iv !== undefined
        ? Number(position.current_iv) - Number(position.entry_iv)
        : 0);

  const elapsed_seconds = Number(position.elapsed_seconds) || 0;
  const total_pnl = Number(position.total_pnl) || 0;

  const normalizeZero = (v: number) => (Object.is(v, -0) ? 0 : v);

  const delta_pnl = normalizeZero(quantity * contract_value * delta * delta_spot);
  const gamma_pnl = normalizeZero(0.5 * quantity * contract_value * gamma * (delta_spot ** 2));
  const theta_pnl = normalizeZero(theta * (elapsed_seconds / 86400));
  const vega_pnl = normalizeZero(vega * delta_vol * 100);
  const other_pnl = normalizeZero(total_pnl - delta_pnl - gamma_pnl - theta_pnl - vega_pnl);

  return {
    symbol: position.symbol,
    delta_pnl,
    gamma_pnl,
    theta_pnl,
    vega_pnl,
    other_pnl,
    total_pnl,
  };
}
