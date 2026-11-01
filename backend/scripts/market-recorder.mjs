/**
 * Raw market recorder for the multi-asset work. Public Delta India data only: it uses no API keys and has no way to place an order.
 *
 * Each minute it stores the option tickers for BTC, ETH and XAUT plus each perpetual's ticker; each hour it stores the product lists.
 * Responses are kept as received, so metrics can be recomputed later (the golden replay runs old and new code over the same input).
 * A failed request is stored as a failed line, so a gap is visible and never silent.
 *
 * Files: <dir>/YYYY-MM-DDTHH.jsonl while the hour is open, then <dir>/YYYY-MM-DDTHH.jsonl.br. No dependencies, so it runs on plain node.
 */
import { appendFileSync, createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statfsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { constants, createBrotliCompress } from 'node:zlib';

const BASE = 'https://api.india.delta.exchange';
const ASSETS = ['BTC', 'ETH', 'XAUT'];
const PERPS = ['BTCUSD', 'ETHUSD', 'XAUTUSD'];
const TIMEOUT_MS = 20_000;
export const MIN_FREE_BYTES = 3 * 1024 ** 3;

/** The requests due at a timestamp: tickers always, product lists on the first minute of the hour and on start. */
export function jobsDue(nowMs, first = false) {
  const jobs = ASSETS.map((a) => ({ key: `chain:${a}`, path: `/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=${a}` }));
  for (const s of PERPS) jobs.push({ key: `perp:${s}`, path: `/v2/tickers/${s}` });
  if (first || new Date(nowMs).getUTCMinutes() === 0) {
    for (const a of ASSETS) jobs.push({ key: `products:${a}`, path: `/v2/products?contract_types=call_options,put_options&underlying_asset_symbols=${a}&states=live&page_size=1000` });
  }
  return jobs;
}

export const hourName = (ms) => new Date(ms).toISOString().slice(0, 13);

/** One stored line. The body stays exactly as received when it is valid JSON. */
export async function fetchLine(fetcher, job, nowMs) {
  const head = `"t":${nowMs},"key":${JSON.stringify(job.key)}`;
  try {
    const res = await fetcher(`${BASE}${job.path}`, { headers: { Accept: 'application/json', 'User-Agent': 'desk-market-recorder' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    JSON.parse(text);
    return res.ok ? `{${head},"ok":true,"body":${text}}\n` : `{${head},"ok":false,"status":${res.status},"error":"http error"}\n`;
  } catch (e) {
    return `{${head},"ok":false,"error":${JSON.stringify(String(e?.message ?? e))}}\n`;
  }
}

/** Fetches and appends one minute. Returns false when the disk guard stopped it. */
export async function recordTick({ fetcher, dir, nowMs, first = false, freeBytes }) {
  if (freeBytes(dir) < MIN_FREE_BYTES) return false;
  const lines = await Promise.all(jobsDue(nowMs, first).map((j) => fetchLine(fetcher, j, nowMs)));
  appendFileSync(join(dir, `${hourName(nowMs)}.jsonl`), lines.join(''));
  return true;
}

/** Compresses every finished hour. The original goes only after the compressed file is complete. */
export async function compressClosed(dir, nowMs) {
  const open = `${hourName(nowMs)}.jsonl`;
  const done = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl') && n !== open).sort()) {
    const src = join(dir, name);
    const tmp = `${src}.br.tmp`;
    await pipeline(
      createReadStream(src),
      createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_LGWIN]: 24 } }),
      createWriteStream(tmp),
    );
    renameSync(tmp, `${src}.br`);
    unlinkSync(src);
    done.push(name);
  }
  return done;
}

function run() {
  const dir = process.env.RECORDER_DIR || '/data';
  const maxTicks = Number(process.env.RECORDER_MAX_TICKS || 0);
  const freeBytes = (d) => { const s = statfsSync(d); return s.bavail * s.bsize; };
  mkdirSync(dir, { recursive: true });
  let ticks = 0;
  let compressing = false;
  let warnedAt = 0;

  const compress = () => {
    if (compressing) return Promise.resolve();
    compressing = true;
    return compressClosed(dir, Date.now())
      .then((names) => { for (const n of names) console.log(`[recorder] compressed ${n}`); })
      .catch((e) => console.error('[recorder] compress failed', e))
      .finally(() => { compressing = false; });
  };

  const tick = async () => {
    const nowMs = Date.now();
    try {
      const ok = await recordTick({ fetcher: fetch, dir, nowMs, first: ticks === 0, freeBytes });
      if (!ok && nowMs - warnedAt > 3_600_000) { warnedAt = nowMs; console.error('[recorder] disk guard: free space below 3 GB, not writing'); }
    } catch (e) {
      console.error('[recorder] tick failed', e);
    }
    ticks += 1;
    if (maxTicks && ticks >= maxTicks) { await compress(); return; }
    void compress();
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 2_000);
  };

  console.log(`[recorder] started, writing to ${dir}`);
  void tick();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
