import WebSocket from 'ws';
import { db, marketTimeseries } from '../db/index.js';
import { alertService } from './alert-service.js';

export class BinanceMarketWorker {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private recentBars: { open: number; high: number; low: number; close: number }[] = [];

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

              // Maintain 30-bar rolling window for Parkinson / Garman-Klass RV calculation
              this.recentBars.push({ open, high, low, close });
              if (this.recentBars.length > 30) this.recentBars.shift();

              const rvAnnualized = this.calculateGarmanKlassRv(this.recentBars);

              // Persist bar to market_timeseries
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

              // Trigger alert check
              await alertService.checkMetrics({
                spotPrice: currentClose,
                realizedVol: rvAnnualized,
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

  /**
   * Calculates Garman-Klass Realized Volatility annualized percentage
   */
  private calculateGarmanKlassRv(bars: { open: number; high: number; low: number; close: number }[]): number {
    if (bars.length < 5) return 0;
    let sum = 0;
    for (const b of bars) {
      const u = Math.log(b.high / b.open);
      const d = Math.log(b.low / b.open);
      const c = Math.log(b.close / b.open);
      // Garman-Klass formula: 0.5 * (ln(H/L))^2 - (2*ln(2) - 1) * (ln(C/O))^2
      const hl = Math.log(b.high / b.low);
      sum += 0.5 * hl * hl - (2 * Math.LN2 - 1) * c * c;
    }
    const variance = sum / bars.length;
    // Annualize 1-minute bars: sqrt(variance * 525,600 minutes/year) * 100
    const annualized = Math.sqrt(variance * 525600) * 100;
    return Number.isFinite(annualized) ? annualized : 0;
  }
}

export const binanceWorker = new BinanceMarketWorker();
