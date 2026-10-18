import WebSocket from 'ws';
import { db, indicatorSnapshots } from '../db/index.js';
import { alertService } from './alert-service.js';

export class DeltaMarketWorker {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private snapshotInterval: NodeJS.Timeout | null = null;

  public currentMarkPrice: number | null = null;
  public currentSpotPrice: number | null = null;
  public currentOi: number | null = null;
  public currentFundingRate: number | null = null;
  public lastTickTime: Date | null = null;
  public status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();

    // Persist 5-minute indicator snapshot
    const fiveMinutes = 5 * 60 * 1000;
    this.snapshotInterval = setInterval(() => this.recordSnapshot(), fiveMinutes);
  }

  stop() {
    this.isRunning = false;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.status = 'DISCONNECTED';
  }

  private connect() {
    if (!this.isRunning) return;

    // Delta Exchange India Public Socket
    const url = 'wss://socket.india.delta.exchange';
    this.status = 'RECONNECTING';

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.status = 'CONNECTED';
        console.log('[DeltaWorker] Connected to Delta Exchange India WebSocket.');

        // Subscribe to BTCUSD and options ticker channel
        const subMsg = {
          type: 'subscribe',
          payload: {
            channels: [
              {
                name: 'v2/ticker',
                symbols: ['BTCUSD', 'BTCUSDT'],
              },
            ],
          },
        };
        this.ws?.send(JSON.stringify(subMsg));
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload.type === 'v2/ticker' || payload.channel === 'v2/ticker') {
            const d = payload.data || payload;
            if (d.mark_price) this.currentMarkPrice = parseFloat(d.mark_price);
            if (d.spot_price) this.currentSpotPrice = parseFloat(d.spot_price);
            if (d.open_interest) this.currentOi = parseFloat(d.open_interest);
            if (d.funding_rate) this.currentFundingRate = parseFloat(d.funding_rate);
            this.lastTickTime = new Date();

            // Spot barrier / speed alert checks
            if (this.currentSpotPrice) {
              await alertService.checkMetrics({
                spotPrice: this.currentSpotPrice,
              });
            }
          }
        } catch (err: any) {
          // Non-critical tick parsing error
        }
      });

      this.ws.on('error', (err: any) => {
        console.error('[DeltaWorker] WebSocket error:', err.message);
      });

      this.ws.on('close', () => {
        this.status = 'DISCONNECTED';
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
   * Persists normalized 5-minute indicator snapshot into indicator_snapshots table
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
