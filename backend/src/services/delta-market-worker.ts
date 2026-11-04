import WebSocket from 'ws';
import { db, indicatorSnapshots } from '../db/index.js';
import { alertService } from './alert-service.js';

export type SupportedMarketAsset = 'BTC' | 'ETH' | 'XAUT';

export interface AssetMarketState {
  symbol: string;
  asset: SupportedMarketAsset;
  spotPrice: number | null;
  markPrice: number | null;
  openInterest: number | null;
  fundingRate: number | null;
  lastTickTime: Date | null;
}

/**
 * Maps a Delta Exchange symbol to its canonical underlying asset.
 * Returns null if the symbol is not recognized as BTC, ETH, or XAUT.
 */
export function assetFromSymbol(rawSymbol: string | undefined | null): SupportedMarketAsset | null {
  if (!rawSymbol) return null;
  const s = String(rawSymbol).toUpperCase().trim();
  if (s.includes('BTC') || s === '.DEXBTUSD') return 'BTC';
  if (s.includes('ETH') || s === '.DEETHUSD') return 'ETH';
  if (s.includes('XAUT') || s === '.DEXAUTUSD') return 'XAUT';
  return null;
}

export class DeltaMarketWorker {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private snapshotInterval: NodeJS.Timeout | null = null;

  // Legacy BTC scalar properties preserved exactly for backward compatibility
  public currentMarkPrice: number | null = null;
  public currentSpotPrice: number | null = null;
  public currentOi: number | null = null;
  public currentFundingRate: number | null = null;
  public lastTickTime: Date | null = null;
  private lastAlertCheck = 0;
  public status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';

  // Isolated asset-keyed market state for multi-asset support
  public marketByAsset: Map<SupportedMarketAsset, AssetMarketState> = new Map([
    ['BTC', { symbol: 'BTCUSD', asset: 'BTC', spotPrice: null, markPrice: null, openInterest: null, fundingRate: null, lastTickTime: null }],
    ['ETH', { symbol: 'ETHUSD', asset: 'ETH', spotPrice: null, markPrice: null, openInterest: null, fundingRate: null, lastTickTime: null }],
    ['XAUT', { symbol: 'XAUTUSD', asset: 'XAUT', spotPrice: null, markPrice: null, openInterest: null, fundingRate: null, lastTickTime: null }],
  ]);

  public getAssetState(asset: SupportedMarketAsset): AssetMarketState {
    return this.marketByAsset.get(asset)!;
  }

  public getSpot(asset: SupportedMarketAsset): number | null {
    return this.marketByAsset.get(asset)?.spotPrice ?? null;
  }

  public getMark(asset: SupportedMarketAsset): number | null {
    return this.marketByAsset.get(asset)?.markPrice ?? null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();

    // Persist 5-minute indicator snapshot (strictly for BTCUSDT)
    const fiveMinutes = 5 * 60 * 1000;
    this.snapshotInterval = setInterval(() => this.recordSnapshot(), fiveMinutes);
  }

  stop() {
    this.isRunning = false;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
    this.status = 'DISCONNECTED';
  }

  private resetHeartbeat() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimeout = setTimeout(() => {
      console.warn('[DeltaWorker] Stale WebSocket detected (>3m no tick), terminating for reconnect...');
      try { this.ws?.terminate(); } catch {}
    }, 180_000);
  }

  private connect() {
    if (!this.isRunning) return;

    // Delta Exchange India Public Socket
    const url = 'wss://socket.india.delta.exchange';
    this.status = 'RECONNECTING';

    try {
      if (this.ws) {
        this.ws.removeAllListeners();
        try { this.ws.terminate(); } catch {}
        this.ws = null;
      }
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.status = 'CONNECTED';
        this.resetHeartbeat();
        console.log('[DeltaWorker] Connected to Delta Exchange India WebSocket.');

        // Subscribe to BTC, ETH, and XAUT perpetuals and spot price indices
        const subMsg = {
          type: 'subscribe',
          payload: {
            channels: [
              {
                name: 'v2/ticker',
                symbols: ['BTCUSD', 'BTCUSDT', 'ETHUSD', 'ETHUSDT', 'XAUTUSD'],
              },
              {
                name: 'spot_price',
                symbols: ['.DEXBTUSD', '.DEETHUSD', '.DEXAUTUSD'],
              },
            ],
          },
        };
        this.ws?.send(JSON.stringify(subMsg));
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        await this.handleMessage(data);
      });

      this.ws.on('error', (err: any) => {
        console.error('[DeltaWorker] WebSocket error:', err.message);
      });

      this.ws.on('close', () => {
        this.status = 'DISCONNECTED';
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
        if (this.isRunning) {
          console.log('[DeltaWorker] Disconnected. Reconnecting in 5s...');
          this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        }
      });
    } catch (err: any) {
      console.error('[DeltaWorker] Connection initialization error:', err.message);
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
      }
    }
  }

  /**
   * Process an incoming WebSocket message safely routing ticks to isolated asset states.
   */
  public async handleMessage(data: WebSocket.Data | string) {
    this.resetHeartbeat();
    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());

      if (payload.type === 'v2/ticker' || payload.channel === 'v2/ticker') {
        const d = payload.data || payload;
        const symbol = String(d.symbol || payload.symbol || '');
        const asset = assetFromSymbol(symbol);
        if (!asset) return; // Safely ignore unknown or invalid symbols

        const mark = d.mark_price ? parseFloat(d.mark_price) : null;
        const spot = d.spot_price ? parseFloat(d.spot_price) : null;
        const oi = d.open_interest ? parseFloat(d.open_interest) : null;
        const funding = d.funding_rate ? parseFloat(d.funding_rate) : null;
        const now = new Date();

        // 1. Update the isolated asset state
        const state = this.marketByAsset.get(asset)!;
        state.symbol = symbol || state.symbol;
        if (mark !== null && !isNaN(mark)) state.markPrice = mark;
        if (spot !== null && !isNaN(spot)) state.spotPrice = spot;
        if (oi !== null && !isNaN(oi)) state.openInterest = oi;
        if (funding !== null && !isNaN(funding)) state.fundingRate = funding;
        state.lastTickTime = now;

        // 2. Existing scalar properties and alert triggers are STRICTLY for BTC
        if (asset === 'BTC') {
          if (mark !== null && !isNaN(mark)) this.currentMarkPrice = mark;
          if (spot !== null && !isNaN(spot)) this.currentSpotPrice = spot;
          if (oi !== null && !isNaN(oi)) this.currentOi = oi;
          if (funding !== null && !isNaN(funding)) this.currentFundingRate = funding;
          this.lastTickTime = now;

          // Spot barrier / speed alert checks strictly for BTC
          if (this.currentSpotPrice) {
            const nowMs = Date.now();
            if (nowMs - this.lastAlertCheck >= 1000) {
              this.lastAlertCheck = nowMs;
              await alertService.checkMetrics({ spotPrice: this.currentSpotPrice });
            }
          }
        }
      } else if (payload.type === 'spot_price') {
        const symbol = String(payload.symbol || payload.sy || '');
        const asset = assetFromSymbol(symbol);
        if (!asset) return;

        const spot = payload.price != null ? parseFloat(payload.price) : null;
        if (spot !== null && !isNaN(spot)) {
          const state = this.marketByAsset.get(asset)!;
          state.spotPrice = spot;
          state.lastTickTime = new Date();

          if (asset === 'BTC') {
            this.currentSpotPrice = spot;
            this.lastTickTime = state.lastTickTime;
            const nowMs = Date.now();
            if (nowMs - this.lastAlertCheck >= 1000) {
              this.lastAlertCheck = nowMs;
              await alertService.checkMetrics({ spotPrice: this.currentSpotPrice });
            }
          }
        }
      }
    } catch (err: any) {
      // Non-critical tick parsing error
    }
  }

  /**
   * Persists normalized 5-minute indicator snapshot into indicator_snapshots table.
   * STRICTLY records BTCUSDT for downstream ask and terminal compatibility.
   */
  private async recordSnapshot() {
    if (!this.currentSpotPrice && !this.currentMarkPrice) return;

    try {
      const now = new Date();
      // Floor to 5-minute boundary
      const boundaryMs = Math.floor(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
      const snapshotTime = new Date(boundaryMs);

      await db
        .insert(indicatorSnapshots)
        .values({
          id: crypto.randomUUID(),
          recordedAt: snapshotTime,
          symbol: 'BTCUSDT',
          fundingRate: this.currentFundingRate ? String(this.currentFundingRate) : null,
          openInterest: this.currentOi ? String(this.currentOi) : null,
          rawSnapshot: {
            source: 'delta_india_ws',
            markPrice: this.currentMarkPrice,
            spotPrice: this.currentSpotPrice,
            oi: this.currentOi,
            fundingRate: this.currentFundingRate,
            t: boundaryMs,
          },
        })
        .onConflictDoNothing();
    } catch (err: any) {
      console.error('[DeltaWorker] Failed to record 5-minute snapshot:', err.message);
    }
  }
}

export const deltaWorker = new DeltaMarketWorker();
