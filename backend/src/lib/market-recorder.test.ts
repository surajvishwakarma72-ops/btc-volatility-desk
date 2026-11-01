import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs with no type declarations
import { compressClosed, fetchLine, hourName, jobsDue, MIN_FREE_BYTES, recordTick } from '../../scripts/market-recorder.mjs';

const T = Date.UTC(2026, 10, 1, 3, 20, 2);
const lots = () => MIN_FREE_BYTES * 2;
const ok = (body: string) => async () => new Response(body, { status: 200 });

describe('market recorder', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recorder-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks for all three chains and perpetuals, and product lists only on the hour or at start', () => {
    const keys = (t: number, first = false) => jobsDue(t, first).map((j: { key: string }) => j.key);
    expect(keys(T)).toEqual(['chain:BTC', 'chain:ETH', 'chain:XAUT', 'perp:BTCUSD', 'perp:ETHUSD', 'perp:XAUTUSD']);
    expect(keys(T, true)).toContain('products:XAUT');
    expect(keys(Date.UTC(2026, 10, 1, 4, 0, 2))).toContain('products:BTC');
  });

  it('never calls anything but a public GET path', () => {
    for (const j of jobsDue(T, true)) expect(j.path).toMatch(/^\/v2\/(tickers|products)/);
  });

  it('keeps a good body as received', async () => {
    const line = await fetchLine(ok('{"result":[1]}'), { key: 'chain:BTC', path: '/x' }, T);
    expect(JSON.parse(line)).toEqual({ t: T, key: 'chain:BTC', ok: true, body: { result: [1] } });
  });

  it('records a failure as a visible line', async () => {
    const down = await fetchLine(async () => { throw new Error('boom'); }, { key: 'k', path: '/x' }, T);
    expect(JSON.parse(down)).toMatchObject({ ok: false, error: 'boom' });
    const http = await fetchLine(async () => new Response('{}', { status: 429 }), { key: 'k', path: '/x' }, T);
    expect(JSON.parse(http)).toMatchObject({ ok: false, status: 429 });
    const html = await fetchLine(ok('<html>'), { key: 'k', path: '/x' }, T);
    expect(JSON.parse(html).ok).toBe(false);
  });

  it('appends one line per job to the hour file', async () => {
    expect(await recordTick({ fetcher: ok('{}'), dir, nowMs: T, freeBytes: lots })).toBe(true);
    const text = readFileSync(join(dir, `${hourName(T)}.jsonl`), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(6);
  });

  it('stops writing when the disk is low', async () => {
    expect(await recordTick({ fetcher: ok('{}'), dir, nowMs: T, freeBytes: () => MIN_FREE_BYTES - 1 })).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('compresses closed hours, leaves the open hour, and the content survives', async () => {
    const closed = `${hourName(T - 3_600_000)}.jsonl`;
    const open = `${hourName(T)}.jsonl`;
    writeFileSync(join(dir, closed), '{"a":1}\n');
    writeFileSync(join(dir, open), '{"b":2}\n');
    expect(await compressClosed(dir, T)).toEqual([closed]);
    expect(readdirSync(dir).sort()).toEqual([`${closed}.br`, open].sort());
    expect(brotliDecompressSync(readFileSync(join(dir, `${closed}.br`))).toString()).toBe('{"a":1}\n');
  });
});
