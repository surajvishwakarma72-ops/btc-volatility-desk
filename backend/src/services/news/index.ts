/** Wires the shock-alert watcher to the real world: fetch, BTC spot, Telegram/ntfy/push, the desk socket, Postgres. */
import { alertService } from '../alert-service.js';
import { binanceWorker } from '../binance-market-worker.js';
import { deltaWorker } from '../delta-market-worker.js';
import { deskEvents } from '../desk-events.js';
import { pgNewsStore } from './news-store.js';
import { NewsWatcher } from './news-watcher.js';

const UA = 'Mozilla/5.0 (compatible; BTCVolatilityDesk/1.0; news alerts)';

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, application/json, */*' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/** 1-minute BTC closes for the last ~33 h, so the "normal move" baseline exists right after a restart. */
async function seedPrices() {
  const out: { t: number; p: number }[] = [];
  let end = Date.now();
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000&endTime=${end}`, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) break;
    const rows = (await r.json()) as unknown[][];
    if (!rows.length) break;
    for (const k of rows) out.push({ t: Number(k[6]), p: Number(k[4]) });
    end = Number(rows[0][0]) - 1;
  }
  return out.sort((a, b) => a.t - b.t);
}

export const newsWatcher = new NewsWatcher({
  now: () => Date.now(),
  fetchText,
  spot: () => binanceWorker.currentSpotPrice || deltaWorker.currentSpotPrice || null,
  notify: async (n) => {
    await alertService.sendNotification({
      title: n.title,
      message: n.message,
      channels: n.telegram ? ['telegram', 'ntfy', 'in_app'] : ['in_app'],
    });
  },
  broadcast: (type, event) => { deskEvents.emit('news', { type, event }); },
  store: pgNewsStore,
  seedPrices,
});
