import { db, optionFlowBuckets } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { alertService } from './alert-service.js';
import { filterNewTrades, computeIvChangePct, type SeqTrade } from '../lib/flow.js';

export class DeribitFlowWorker {
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  public currentDvol: number | null = null;
  public lastPollTime: Date | null = null;
  private lastTradeSeq: number | null = null;
  private prevDvol: number | null = null;
  public status: 'IDLE' | 'POLLING' | 'ERROR' = 'IDLE';

  start(intervalMs = 60_000) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
    this.pollInterval = setInterval(() => this.poll(), intervalMs);
    console.log('[DeribitWorker] Started Deribit DVOL & options flow poller.');
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.status = 'IDLE';
  }

  private async poll() {
    if (!this.isRunning) return;
    this.status = 'POLLING';

    try {
      await Promise.allSettled([
        this.pollDvol(),
        this.pollOptionsFlow(),
      ]);
      this.lastPollTime = new Date();
      this.status = 'IDLE';
    } catch (err: any) {
      console.error('[DeribitWorker] Poll cycle error:', err.message);
      this.status = 'ERROR';
    }
  }

  /**
   * Fetches latest BTC DVOL (Implied Volatility Index) from Deribit
   */
  private async pollDvol() {
    try {
      const now = Date.now();
      const start = now - 3600_000 * 2;
      const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${now}&resolution=60`;
      
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BTC-Volatility-Desk' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;

      const data = await res.json() as any;
      const points = data?.result?.data;
      if (Array.isArray(points) && points.length > 0) {
        const latest = points[points.length - 1]; // [timestamp, open, high, low, close]
        const dvolValue = parseFloat(latest[4]);
        if (Number.isFinite(dvolValue)) {
          this.currentDvol = dvolValue;
          const ivChangePct = computeIvChangePct(this.prevDvol, dvolValue);
          this.prevDvol = dvolValue;
          if (ivChangePct != null) {
            await alertService.checkMetrics({ atmIv: dvolValue, ivChangePct });
          }
        }
      }
    } catch (err: any) {
      // Non-critical background poller error
    }
  }

  /**
   * Fetches latest executed options trades and aggregates into 15-minute buckets
   */
  private async pollOptionsFlow() {
    try {
      const url = 'https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=BTC&kind=option&count=50';
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BTC-Volatility-Desk' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;

      const json = await res.json() as any;
      const trades = json?.result?.trades;
      if (!Array.isArray(trades) || trades.length === 0) return;

      const { fresh, maxSeq } = filterNewTrades(trades as SeqTrade[], this.lastTradeSeq);
      this.lastTradeSeq = maxSeq;
      if (fresh.length === 0) return;

      // Group trades into 15-minute floor bucket
      const bucketDurationMs = 15 * 60 * 1000;

      for (const tr of fresh as any[]) {
        const tradeTime = tr.timestamp;
        const bucketTime = new Date(Math.floor(tradeTime / bucketDurationMs) * bucketDurationMs);
        const amount = parseFloat(tr.amount || '0') || 0;
        const isCall = tr.instrument_name.includes('-C');
        const isBuy = tr.direction === 'buy';
        const isBlock = tr.block_trade_id != null || amount >= 10; // 10+ BTC option size

        const callSell = isCall && !isBuy ? amount : 0;
        const callBuy = isCall && isBuy ? amount : 0;
        const putSell = !isCall && !isBuy ? amount : 0;
        const putBuy = !isCall && isBuy ? amount : 0;

        const blockCallSell = isBlock && isCall && !isBuy ? amount : 0;
        const blockCallBuy = isBlock && isCall && isBuy ? amount : 0;
        const blockPutSell = isBlock && !isCall && !isBuy ? amount : 0;
        const blockPutBuy = isBlock && !isCall && isBuy ? amount : 0;

        await db
          .insert(optionFlowBuckets)
          .values({
            time: bucketTime,
            symbol: 'BTC',
            callSellVol: String(callSell),
            callBuyVol: String(callBuy),
            putSellVol: String(putSell),
            putBuyVol: String(putBuy),
            blockCallSellVol: String(blockCallSell),
            blockCallBuyVol: String(blockCallBuy),
            blockPutSellVol: String(blockPutSell),
            blockPutBuyVol: String(blockPutBuy),
            tradeCount: 1,
            rawFlow: { latestSample: tr },
          })
          .onConflictDoUpdate({
            target: [optionFlowBuckets.symbol, optionFlowBuckets.time],
            set: {
              callSellVol: sql`option_flow_buckets.call_sell_vol + ${callSell}`,
              callBuyVol: sql`option_flow_buckets.call_buy_vol + ${callBuy}`,
              putSellVol: sql`option_flow_buckets.put_sell_vol + ${putSell}`,
              putBuyVol: sql`option_flow_buckets.put_buy_vol + ${putBuy}`,
              blockCallSellVol: sql`option_flow_buckets.block_call_sell_vol + ${blockCallSell}`,
              blockCallBuyVol: sql`option_flow_buckets.block_call_buy_vol + ${blockCallBuy}`,
              blockPutSellVol: sql`option_flow_buckets.block_put_sell_vol + ${blockPutSell}`,
              blockPutBuyVol: sql`option_flow_buckets.block_put_buy_vol + ${blockPutBuy}`,
              tradeCount: sql`option_flow_buckets.trade_count + 1`,
            },
          });
      }
    } catch (err: any) {
      // Non-critical background poller error
    }
  }
}

export const deribitWorker = new DeribitFlowWorker();
