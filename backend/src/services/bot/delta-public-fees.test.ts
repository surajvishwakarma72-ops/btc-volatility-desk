import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPTION_FEES, DEFAULT_PERP, fetchOptionFeeRates, fetchPerpInfo } from './delta-public.js';

const product = (symbol: string, contract_value = '0.002') => ({ symbol, taker_commission_rate: '0.0002', maker_commission_rate: '0.0002', contract_value, product_specs: { premium_commission_rate: 0.04 } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('fetchOptionFeeRates', () => {
  it('reads every page, so a symbol past the first page gets its real rates', async () => {
    const f = vi.fn(async (url: string) => (url.includes('after=abc')
      ? json({ result: [product('C-BTC-90000-271126')], meta: { after: null } })
      : json({ result: [product('C-BTC-80000-271126')], meta: { after: 'abc' } })));
    vi.stubGlobal('fetch', f);
    const rates = await fetchOptionFeeRates(['C-BTC-90000-271126']);
    expect(f).toHaveBeenCalledTimes(2);
    expect(rates.get('C-BTC-90000-271126')?.contractValue).toBe(0.002);
  });

  it('keeps the fallback for BTC and logs it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rates = await fetchOptionFeeRates(['C-BTC-80000-271126']);
    expect(rates.get('C-BTC-80000-271126')).toEqual(DEFAULT_OPTION_FEES);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses to price another asset with BTC lot size', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(fetchOptionFeeRates(['C-ETH-2400-271126'])).rejects.toThrow(/C-ETH-2400-271126/);
  });
});

describe('fetchPerpInfo', () => {
  it('keeps the fallback for BTCUSD', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchPerpInfo()).toEqual(DEFAULT_PERP);
    warn.mockRestore();
  });

  it('refuses to give another perpetual BTC values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(fetchPerpInfo('XAUTUSD')).rejects.toThrow(/XAUTUSD/);
  });
});
