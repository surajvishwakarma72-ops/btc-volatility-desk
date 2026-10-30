import { recordIvSnapshot, ensureIvHistorySchema } from './iv-rank.js';

export interface FeedStatus {
  running: boolean;
  last_poll_at: string | null;
  error_count: number;
}

export interface DeltaFeedOptions {
  intervalMs?: number;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  endpointUrl?: string;
  immediate?: boolean;
}

let isRunning = false;
let lastPollAt: string | null = null;
let errorCount = 0;
let pollTimer: NodeJS.Timeout | null = null;

export const DELTA_OPTIONS_GREEKS_URL = 'https://api.india.delta.exchange/v2/options/greeks';

export function getFeedStatus(): FeedStatus {
  return {
    running: isRunning,
    last_poll_at: lastPollAt,
    error_count: errorCount,
  };
}

export function resetFeedStatus(): void {
  errorCount = 0;
  lastPollAt = null;
}

export function stopDeltaFeed(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
}

/**
 * Poll Delta Exchange options/greeks endpoint and insert mark_vol into iv_history.
 * On error: log to console only, never throw, never crash.
 */
export async function pollDeltaFeed(options?: DeltaFeedOptions): Promise<void> {
  const fetchImpl = options?.fetchFn || globalThis.fetch;
  const endpoint = options?.endpointUrl || DELTA_OPTIONS_GREEKS_URL;

  lastPollAt = new Date().toISOString();

  try {
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BTC-Volatility-Desk/1.0',
      },
    });

    if (!res.ok) {
      throw new Error(`Delta Exchange API returned HTTP ${res.status}: ${res.statusText}`);
    }

    const json: any = await res.json();
    const optionsList: any[] = Array.isArray(json?.result)
      ? json.result
      : Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json)
          ? json
          : [];

    await ensureIvHistorySchema();

    let hasCurrent = false;

    for (const item of optionsList) {
      if (!item || typeof item !== 'object') continue;

      // mark_vol comes as decimal (0.165) — store as-is, never multiply
      const rawVol = item.mark_vol ?? item.markVol ?? item.mark_iv ?? item.iv;
      if (rawVol === undefined || rawVol === null || rawVol === '') continue;

      const markVol = Number(rawVol);
      if (isNaN(markVol)) continue;

      const expiryLabel = String(
        item.expiry_label ?? item.expiry ?? item.symbol ?? 'Current'
      ).trim();

      if (expiryLabel === 'Current') {
        hasCurrent = true;
      }

      try {
        if (options?.baseUrl) {
          try {
            await fetchImpl(`${options.baseUrl}/api/v1/iv/record`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ expiry_label: expiryLabel, mark_vol: markVol }),
            });
          } catch {
            await recordIvSnapshot(expiryLabel, markVol);
          }
        } else {
          await recordIvSnapshot(expiryLabel, markVol);
        }
      } catch (recordErr: any) {
        console.error('[delta-feed] failed to record option:', expiryLabel, recordErr?.message || recordErr);
      }
    }

    // If no option explicitly carried the label "Current", update "Current" using the first available mark_vol
    if (!hasCurrent && optionsList.length > 0) {
      const first = optionsList[0];
      const rawVol = first.mark_vol ?? first.markVol ?? first.mark_iv ?? first.iv;
      if (rawVol !== undefined && rawVol !== null && rawVol !== '') {
        const markVol = Number(rawVol);
        if (!isNaN(markVol)) {
          try {
            if (options?.baseUrl) {
              try {
                await fetchImpl(`${options.baseUrl}/api/v1/iv/record`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ expiry_label: 'Current', mark_vol: markVol }),
                });
              } catch {
                await recordIvSnapshot('Current', markVol);
              }
            } else {
              await recordIvSnapshot('Current', markVol);
            }
          } catch {}
        }
      }
    }
  } catch (err: any) {
    errorCount++;
    console.error('[delta-feed] poll error:', err?.message || err);
    // On error: log to console only, never throw, never crash
  }
}

/**
 * Start the Delta live feed polling service.
 * Defaults to polling every 60s.
 */
export function startDeltaFeed(options?: DeltaFeedOptions): { stop: () => void } {
  try {
    stopDeltaFeed();
    isRunning = true;

    const intervalMs = options?.intervalMs ?? 60000;

    const execute = () => {
      void pollDeltaFeed(options).catch((err) => {
        errorCount++;
        console.error('[delta-feed] unexpected loop error:', err?.message || err);
      });
    };

    if (options?.immediate !== false) {
      execute();
    }

    pollTimer = setInterval(execute, intervalMs);

    return {
      stop: stopDeltaFeed,
    };
  } catch (err: any) {
    errorCount++;
    console.error('[delta-feed] start error:', err?.message || err);
    return {
      stop: stopDeltaFeed,
    };
  }
}
