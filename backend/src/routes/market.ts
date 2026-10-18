import type { FastifyPluginAsync } from 'fastify';

/**
 * Market Data & Historical Time-Series Routes Stub
 * 
 * Future Endpoints:
 * - GET /api/v1/market/candles       Historical normalized OHLCV candles (1m, 5m, 15m, 1h, 1d)
 * - GET /api/v1/market/iv-history    Historical ATM IV and DVOL data points
 * - GET /api/v1/market/rv            Calculated Realized Volatility series (Parkinson, Garman-Klass)
 * - GET /api/v1/market/oi-metrics    Binance Futures 5-min Open Interest delta and liquidation data
 * - GET /api/v1/market/events        Upcoming macroeconomic & crypto exploits schedule
 * 
 * Notes:
 * - Served from backend time-series cache and database (`market_timeseries`).
 * - Replaces direct client-side requests to Binance/Deribit, avoiding CORS and rate-limits.
 */
export const marketRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
