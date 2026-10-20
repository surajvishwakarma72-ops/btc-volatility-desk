import WebSocket from 'ws';
import { db, marketTimeseries } from '../db/index.js';
import { alertService } from './alert-service.js';
import { garmanKlassRv, computeVelocityPct, type Bar } from '../lib/volatility.js';

export class BinanceMarketWorker {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private recentBars: Bar[] = [];
  private recentCloses: number[] = [];

  public currentSpotPrice: number | null = null;
  public lastKlineTime: Date | null = null;
  public status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' = 'DISCONNECTED';

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  stop() {
    this.isRunning = false;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.status = 'DISCONNECTED';
  }

  private connect() {
    if (!this.isRunning) return;

    // Connect to Binance Spot Kline stream (port 9443 avoids ISP filtering)
    const url = 'wss://stream.binance.com:9443/ws/btcusdt@kline_1m';
    this.status = 'RECONNECTING';

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.status = 'CONNECTED';
        console.log('[BinanceWorker] Connected to Binance 1m Kline stream.');
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload.e === 'kline' && payload.k) {
            const k = payload.k;
            const currentClose = parseFloat(k.c);
            this.currentSpotPrice = currentClose;
            this.lastKlineTime = new Date(k.t);

            // Check if candle is finalized (k.x === true)
            if (k.x) {
              const barTime = new Date(k.t);
              this.lastKlineTime = barTime;

              const open = parseFloat(k.o);
              const high = parseFloat(k.h);
              const low = parseFloat(k.l);
              const close = currentClose;
              const volume = parseFloat(k.v);

              const bar: Bar = { open, high, low, close };
              this.recentBars.push(bar);
              if (this.recentBars.length > 30) this.recentBars.shift();
              this.recentCloses.push(close);
              if (this.recentCloses.length > 10) this.recentCloses.shift();

              const rvAnnualized = garmanKlassRv(this.recentBars);
              const velocity = computeVelocityPct(this.recentCloses, 3);

              await db
                .insert(marketTimeseries)
                .values({
                  time: barTime,
                  symbol: 'BTCUSDT',
                  interval: '1m',
                  open: String(open),
                  high: String(high),
                  low: String(low),
                  close: String(close),
                  volume: String(volume),
                  rv: rvAnnualized ? String(rvAnnualized.toFixed(2)) : null,
                })
                .onConflictDoNothing();

              await alertService.checkMetrics({
                spotPrice: currentClose,
                realizedVol: rvAnnualized,
                speed: velocity,
              });
            }
          }
        } catch (err: any) {
          console.error('[BinanceWorker] Message processing error:', err.message);
        }
      });

      this.ws.on('error', (err: any) => {
        console.error('[BinanceWorker] WebSocket error:', err.message);
      });

      this.ws.on('close', () => {
        this.status = 'DISCONNECTED';
        if (this.isRunning) {
          console.log('[BinanceWorker] Stream disconnected. Reconnecting in 5s...');
          this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        }
      });
    } catch (err: any) {
      console.error('[BinanceWorker] Connection initialization error:', err.message);
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
      }
    }
  }

}

export const binanceWorker = new BinanceMarketWorker();
