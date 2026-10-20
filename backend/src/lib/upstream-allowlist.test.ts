import { describe, it, expect } from 'vitest';
import { isAllowed } from './upstream-allowlist.js';

describe('isAllowed', () => {
  it('allows listed Delta public paths', () => {
    expect(isAllowed('https://api.india.delta.exchange/v2/tickers/BTCUSD')).toBe(true);
    expect(isAllowed('https://api.india.delta.exchange/v2/l2orderbook/BTCUSD?depth=20')).toBe(true);
  });
  it('allows Deribit, Binance, OKX and news hosts', () => {
    expect(isAllowed('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC')).toBe(true);
    expect(isAllowed('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m')).toBe(true);
    expect(isAllowed('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP')).toBe(true);
    expect(isAllowed('https://api.llama.fi/hacks')).toBe(true);
  });
  it('rejects unknown hosts and non-https', () => {
    expect(isAllowed('https://evil.example.com/v2/tickers')).toBe(false);
    expect(isAllowed('http://api.india.delta.exchange/v2/tickers')).toBe(false);
    expect(isAllowed('https://api.india.delta.exchange/v2/wallet/balances')).toBe(false); // account path not public
    expect(isAllowed('not a url')).toBe(false);
  });
});
