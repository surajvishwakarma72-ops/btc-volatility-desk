import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeltaMarketWorker, assetFromSymbol } from './delta-market-worker.js';

vi.mock('./alert-service.js', () => ({
  alertService: {
    checkMetrics: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../db/index.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
  indicatorSnapshots: {},
}));

describe('DeltaMarketWorker — Multi-Asset Market State & Parity', () => {
  let worker: DeltaMarketWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new DeltaMarketWorker();
  });

  describe('assetFromSymbol helper', () => {
    it('correctly maps BTC symbols', () => {
      expect(assetFromSymbol('BTCUSD')).toBe('BTC');
      expect(assetFromSymbol('BTCUSDT')).toBe('BTC');
      expect(assetFromSymbol('.DEXBTUSD')).toBe('BTC');
      expect(assetFromSymbol('C-BTC-90000-281126')).toBe('BTC');
      expect(assetFromSymbol('P-BTC-80000-281126')).toBe('BTC');
    });

    it('correctly maps ETH symbols', () => {
      expect(assetFromSymbol('ETHUSD')).toBe('ETH');
      expect(assetFromSymbol('ETHUSDT')).toBe('ETH');
      expect(assetFromSymbol('.DEETHUSD')).toBe('ETH');
      expect(assetFromSymbol('C-ETH-2800-281126')).toBe('ETH');
      expect(assetFromSymbol('P-ETH-2400-281126')).toBe('ETH');
    });

    it('correctly maps XAUT symbols', () => {
      expect(assetFromSymbol('XAUTUSD')).toBe('XAUT');
      expect(assetFromSymbol('.DEXAUTUSD')).toBe('XAUT');
      expect(assetFromSymbol('C-XAUT-2750-281126')).toBe('XAUT');
      expect(assetFromSymbol('P-XAUT-2650-281126')).toBe('XAUT');
    });

    it('returns null for unknown, empty, or invalid symbols', () => {
      expect(assetFromSymbol('SOLUSD')).toBeNull();
      expect(assetFromSymbol('DOGEUSDT')).toBeNull();
      expect(assetFromSymbol('')).toBeNull();
      expect(assetFromSymbol(null)).toBeNull();
      expect(assetFromSymbol(undefined)).toBeNull();
    });
  });

  describe('WebSocket tick ingestion & scalar isolation', () => {
    it('BTC ticks update both BTC scalar properties and asset-keyed state', async () => {
      const btcMsg = JSON.stringify({
        type: 'v2/ticker',
        symbol: 'BTCUSD',
        mark_price: '76500.5',
        spot_price: '76480.0',
        open_interest: '1234.56',
        funding_rate: '0.00015',
      });

      await worker.handleMessage(btcMsg);

      // Verify BTC scalar values
      expect(worker.currentSpotPrice).toBe(76480.0);
      expect(worker.currentMarkPrice).toBe(76500.5);
      expect(worker.currentOi).toBe(1234.56);
      expect(worker.currentFundingRate).toBe(0.00015);
      expect(worker.lastTickTime).toBeInstanceOf(Date);

      // Verify BTC asset-keyed state
      const btcState = worker.getAssetState('BTC');
      expect(btcState.spotPrice).toBe(76480.0);
      expect(btcState.markPrice).toBe(76500.5);
      expect(btcState.openInterest).toBe(1234.56);
      expect(btcState.fundingRate).toBe(0.00015);
      expect(btcState.lastTickTime).toBeInstanceOf(Date);

      // Verify ETH and XAUT remain unpopulated
      expect(worker.getSpot('ETH')).toBeNull();
      expect(worker.getSpot('XAUT')).toBeNull();
    });

    it('ETH ticks update ONLY ETH asset state and NEVER overwrite BTC scalar properties', async () => {
      // 1. Establish BTC state
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          symbol: 'BTCUSD',
          mark_price: '75000',
          spot_price: '74950',
          open_interest: '500',
          funding_rate: '0.0001',
        }),
      );
      const btcTickTime = worker.lastTickTime;

      // 2. Feed ETH tick
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          symbol: 'ETHUSD',
          mark_price: '2650.75',
          spot_price: '2648.50',
          open_interest: '9800.2',
          funding_rate: '-0.00005',
        }),
      );

      // 3. Confirm BTC scalar values are COMPLETELY UNCHANGED
      expect(worker.currentSpotPrice).toBe(74950);
      expect(worker.currentMarkPrice).toBe(75000);
      expect(worker.currentOi).toBe(500);
      expect(worker.currentFundingRate).toBe(0.0001);
      expect(worker.lastTickTime).toEqual(btcTickTime);

      // 4. Confirm ETH state is updated properly
      const ethState = worker.getAssetState('ETH');
      expect(ethState.spotPrice).toBe(2648.50);
      expect(ethState.markPrice).toBe(2650.75);
      expect(ethState.openInterest).toBe(9800.2);
      expect(ethState.fundingRate).toBe(-0.00005);
      expect(ethState.lastTickTime).toBeInstanceOf(Date);
    });

    it('XAUT ticks update ONLY XAUT asset state and NEVER overwrite BTC scalar properties', async () => {
      // 1. Establish BTC state
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          symbol: 'BTCUSD',
          mark_price: '80000',
          spot_price: '79900',
          open_interest: '1000',
          funding_rate: '0.0002',
        }),
      );

      // 2. Feed XAUT tick
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          symbol: 'XAUTUSD',
          mark_price: '2780.20',
          spot_price: '2778.90',
          open_interest: '320.5',
          funding_rate: '0.00002',
        }),
      );

      // 3. Confirm BTC scalar values did NOT drop to XAUT price
      expect(worker.currentSpotPrice).toBe(79900);
      expect(worker.currentMarkPrice).toBe(80000);
      expect(worker.currentOi).toBe(1000);
      expect(worker.currentFundingRate).toBe(0.0002);

      // 4. Confirm XAUT state is stored cleanly
      const xautState = worker.getAssetState('XAUT');
      expect(xautState.spotPrice).toBe(2778.90);
      expect(xautState.markPrice).toBe(2780.20);
      expect(xautState.openInterest).toBe(320.5);
      expect(xautState.fundingRate).toBe(0.00002);
    });

    it('spot_price channel messages correctly route to respective assets', async () => {
      // Send ETH spot index
      await worker.handleMessage(
        JSON.stringify({
          type: 'spot_price',
          symbol: '.DEETHUSD',
          price: '2555.50',
        }),
      );

      // Send XAUT spot index
      await worker.handleMessage(
        JSON.stringify({
          type: 'spot_price',
          symbol: '.DEXAUTUSD',
          price: '2795.10',
        }),
      );

      // Send BTC spot index
      await worker.handleMessage(
        JSON.stringify({
          type: 'spot_price',
          symbol: '.DEXBTUSD',
          price: '78200.00',
        }),
      );

      expect(worker.getSpot('ETH')).toBe(2555.50);
      expect(worker.getSpot('XAUT')).toBe(2795.10);
      expect(worker.getSpot('BTC')).toBe(78200.00);

      // Confirm BTC top-level scalar spot matches BTC only
      expect(worker.currentSpotPrice).toBe(78200.00);
    });

    it('safely ignores unknown or malformed ticks without throwing', async () => {
      // Unknown symbol
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          symbol: 'SOLUSD',
          mark_price: '180.0',
          spot_price: '179.5',
        }),
      );

      // Missing symbol
      await worker.handleMessage(
        JSON.stringify({
          type: 'v2/ticker',
          mark_price: '100.0',
        }),
      );

      // Corrupted JSON
      await worker.handleMessage('NOT_VALID_JSON{{{');

      // Zero corruption of BTC state
      expect(worker.currentSpotPrice).toBeNull();
      expect(worker.getSpot('BTC')).toBeNull();
      expect(worker.getSpot('ETH')).toBeNull();
      expect(worker.getSpot('XAUT')).toBeNull();
    });
  });
});

