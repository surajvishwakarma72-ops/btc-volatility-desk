/**
 * The ONLY hosts + path prefixes the public market gateway (/api/v1/mkt) may fetch.
 * Keeps the proxy from being an open relay (SSRF). Account/private Delta paths are
 * intentionally excluded — those go through /api/v1/delta/signed instead.
 */
interface Rule { host: string; prefixes: string[] }

const RULES: Rule[] = [
  { host: 'api.india.delta.exchange', prefixes: ['/v2/products', '/v2/tickers', '/v2/history/candles', '/v2/l2orderbook/', '/v2/trades/'] },
  { host: 'www.deribit.com', prefixes: ['/api/v2/public/'] },
  { host: 'fapi.binance.com', prefixes: ['/fapi/'] },
  { host: 'api.binance.com', prefixes: ['/api/v3/'] },
  { host: 'data-api.binance.vision', prefixes: ['/api/v3/'] },
  { host: 'data.binance.vision', prefixes: ['/data/'] },
  { host: 'www.okx.com', prefixes: ['/api/v5/public/'] },
  { host: 'cryptocurrency.cv', prefixes: ['/api/'] },
  { host: 'api.llama.fi', prefixes: ['/hacks'] },
];

export function isAllowed(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const rule = RULES.find((r) => r.host === u.hostname);
  if (!rule) return false;
  return rule.prefixes.some((p) => u.pathname.startsWith(p));
}

export const ALLOWED_HOSTS = RULES.map((r) => r.host);
