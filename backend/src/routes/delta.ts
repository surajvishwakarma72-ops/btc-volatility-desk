import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { MasterKeyMissing, masterKeyConfigured } from '../lib/crypto.js';
import { userId } from '../lib/guards.js';
import { DESK_USER_ID } from '../services/auth-store.js';
import { deleteDeltaKey, deltaKeyStatus, loadDeltaKey, noteDeltaResult, saveDeltaKey } from '../services/delta-keys.js';

/**
 * Delta Exchange India Authenticated Gateway
 *
 * Provides:
 * - GET /api/v1/delta/signed   Server-side HMAC-signed relay (key+secret from env, never the browser)
 * - GET /api/v1/delta/ip       Retrieve the server's public outbound IP for easy whitelisting on Delta
 * - GET /api/v1/delta/status   Verify gateway health and reachability to Delta
 */

const DELTA_BASE = 'https://api.india.delta.exchange';

/**
 * Sign a Delta Exchange API request using the server-held secret.
 * message = method + timestamp + path + queryString
 * queryString is the '?'-prefixed query string, or empty string.
 */
export function signDelta(secret: string, method: string, ts: string, path: string, query: string, body = ''): string {
  return crypto.createHmac('sha256', secret).update(method + ts + path + query + body).digest('hex');
}

/** The only account endpoints the signed relay will call. Everything is a GET; nothing here can place or change an order. */
export const SIGNED_PATHS = new Set(['/v2/positions/margined', '/v2/positions', '/v2/fills', '/v2/wallet/balances']);

export const isOwner = (request: any): boolean => {
  const u = request.user as { sub?: string; role?: string } | undefined;
  return !!u && (u.role === 'admin' || u.sub === DESK_USER_ID);
};

/** One signed GET to Delta with the given key. Never logs or returns the key. */
export async function deltaSignedGet(key: string, secret: string, path: string, query: string): Promise<{ ok: boolean; status: number; body: unknown; errorText: string }> {
  const ts = String(Math.floor(Date.now() / 1000));
  const q = query ? '?' + query.replace(/^\?/, '') : ''; // normalise to exactly one leading '?' (mirrors the desk's original signing scheme)
  const sig = signDelta(secret, 'GET', ts, path, q);
  try {
    const upstream = await fetch(`${DELTA_BASE}${path}${q}`, {
      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
      signal: AbortSignal.timeout(12_000),
    });
    const data = await upstream.json().catch(() => null);
    const body = data ?? { success: false, error: 'Empty upstream response' };
    return { ok: upstream.ok && (data as any)?.success !== false, status: upstream.status, body, errorText: upstream.ok ? '' : String((data as any)?.error?.code ?? (data as any)?.error ?? upstream.status) };
  } catch (err: any) {
    return { ok: false, status: 502, body: { success: false, error: `Failed to reach Delta: ${err?.message || 'timeout'}` }, errorText: err?.message || 'timeout' };
  }
}

/**
 * One signed POST to Delta. This is the ONLY place in the desk that can write to the exchange, and it is used by exactly one caller:
 * services/watch/live-exit.ts, which sends reduce-only closing orders and sits behind several locks. It never logs the key or secret.
 */
export async function deltaSignedPost(key: string, secret: string, path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: any; errorText: string }> {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const sig = signDelta(secret, 'POST', ts, path, '', body);
  try {
    const upstream = await fetch(`${DELTA_BASE}${path}`, {
      method: 'POST',
      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const data = await upstream.json().catch(() => null);
    const ok = upstream.ok && (data as any)?.success !== false;
    return { ok, status: upstream.status, body: data, errorText: ok ? '' : String((data as any)?.error?.code ?? (data as any)?.error ?? upstream.status) };
  } catch (err: any) {
    return { ok: false, status: 502, body: null, errorText: err?.message || 'timeout' };
  }
}

/** One signed DELETE (cancel an order by id and product). Used only to remove the stop-loss orders the desk placed itself. */
export async function deltaSignedDelete(key: string, secret: string, path: string, payload: unknown): Promise<{ ok: boolean; status: number; body: any; errorText: string }> {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const sig = signDelta(secret, 'DELETE', ts, path, '', body);
  try {
    const upstream = await fetch(`${DELTA_BASE}${path}`, {
      method: 'DELETE',
      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    const data = await upstream.json().catch(() => null);
    const ok = upstream.ok && (data as any)?.success !== false;
    return { ok, status: upstream.status, body: data, errorText: ok ? '' : String((data as any)?.error?.code ?? (data as any)?.error ?? upstream.status) };
  } catch (err: any) {
    return { ok: false, status: 502, body: null, errorText: err?.message || 'timeout' };
  }
}

let cachedServerIp: string | null = null;
let lastIpCheck = 0;

/**
 * Fetch and cache the server's public outbound IPv4 address
 */
export async function getServerOutboundIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedServerIp && now - lastIpCheck < 5 * 60 * 1000) {
    return cachedServerIp;
  }

  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json() as { ip?: string };
      if (json && json.ip) {
        cachedServerIp = json.ip;
        lastIpCheck = now;
        return cachedServerIp;
      }
    }
  } catch {
    // Fallback to secondary IP discovery
    try {
      const res = await fetch('https://api64.ipify.org?format=json', {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json() as { ip?: string };
        if (json && json.ip) {
          cachedServerIp = json.ip;
          lastIpCheck = now;
          return cachedServerIp;
        }
      }
    } catch {
      // Ignore fallback failure
    }
  }

  return cachedServerIp;
}

export const deltaRoutes: FastifyPluginAsync = async (fastify) => {
  // Return server public IP for whitelisting on Delta
  fastify.get('/ip', async (_request, reply) => {
    const ip = await getServerOutboundIp();
    return reply.send({
      success: true,
      serverIp: ip,
      note: 'Add this IP to your Delta Exchange India API key whitelist.',
    });
  });

  // Health and connectivity check to Delta API
  fastify.get('/status', async (_request, reply) => {
    const ip = await getServerOutboundIp();
    try {
      const start = Date.now();
      // /v2/settings is a lightweight public endpoint (Delta India has no /v2/time — that 404s).
      const res = await fetch(`${DELTA_BASE}/v2/settings`, {
        headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      const json = await res.json().catch(() => null);

      return reply.send({
        success: res.ok,
        serverIp: ip,
        deltaReachable: res.ok,
        latencyMs,
        deltaServerTime: json?.result?.server_time ?? json?.result?.epoch,
      });
    } catch (err: any) {
      return reply.status(503).send({
        success: false,
        serverIp: ip,
        deltaReachable: false,
        error: err?.message || 'Failed to ping Delta Exchange',
      });
    }
  });

  // Server-side signed relay for the caller's OWN Delta account (their key, saved encrypted; never the browser, never another user's).
  // Read-only: GET, and only the account endpoints the desk shows. The owner may still fall back to the server's env key until a key is saved.
  fastify.get('/signed', { preHandler: (fastify as any).authenticate, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const qp = (request.query || {}) as { path?: string; query?: string };
    const path = qp.path;
    const query = qp.query || '';
    if (!path || !SIGNED_PATHS.has(path)) {
      return reply.status(400).send({ success: false, error: `path must be one of: ${[...SIGNED_PATHS].join(', ')}` });
    }
    const uid = userId(request);
    let creds: { key: string; secret: string } | null = null;
    let usedKind: 'read' | 'trade' = 'read';
    try {
      creds = await loadDeltaKey(uid, 'read');
      if (!creds) {
        creds = await loadDeltaKey(uid, 'trade');
        if (creds) usedKind = 'trade';
      }
    } catch { return reply.status(500).send({ success: false, error: 'Could not read your saved Delta key' }); }
    if (!creds && isOwner(request) && process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET) creds = { key: process.env.DELTA_API_KEY, secret: process.env.DELTA_API_SECRET };
    if (!creds) return reply.status(409).send({ success: false, error: 'no_delta_key', message: 'Save your Delta API key in Settings first' });
    const r = await deltaSignedGet(creds.key, creds.secret, path, query);
    if (!r.ok) void noteDeltaResult(uid, false, r.errorText, usedKind);
    else void noteDeltaResult(uid, true, null, usedKind);
    return reply.status(r.status).send(r.body);
  });

  // Save, check and remove the caller's own Delta key. The secret is only ever sent in (never returned) and is stored encrypted.
  const authOnly = { preHandler: (fastify as any).authenticate };
  fastify.get('/credentials', authOnly, async (request) => {
    const uid = userId(request);
    const read = await deltaKeyStatus(uid, 'read');
    if (read.connected) {
      return { success: true, encryptionReady: masterKeyConfigured(), keyKind: 'read', ...read };
    }
    const trade = await deltaKeyStatus(uid, 'trade');
    if (trade.connected) {
      return { success: true, encryptionReady: masterKeyConfigured(), keyKind: 'trade', ...trade };
    }
    return { success: true, encryptionReady: masterKeyConfigured(), connected: false };
  });

  fastify.put('/credentials', { ...authOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = z.object({ apiKey: z.string().trim().min(8).max(200), apiSecret: z.string().trim().min(8).max(400) }).safeParse(request.body);
    if (!b.success) return reply.status(400).send({ success: false, error: 'send apiKey and apiSecret' });
    if (!masterKeyConfigured()) return reply.status(503).send({ success: false, error: new MasterKeyMissing().message });
    // prove the key works with one read-only call before keeping it
    const check = await deltaSignedGet(b.data.apiKey, b.data.apiSecret, '/v2/wallet/balances', '');
    if (!check.ok) {
      const code = (check.body as any)?.error?.code ?? (check.body as any)?.error ?? check.errorText;
      const ipHint = /ip_not_whitelisted|whitelist/i.test(String(code)) ? ` Add this server's IP to the key's whitelist on Delta (it is shown in Settings).` : '';
      return reply.status(400).send({ success: false, error: `Delta did not accept this key (${String(code).slice(0, 120)}).${ipHint}` });
    }
    await saveDeltaKey(userId(request), b.data.apiKey, b.data.apiSecret);
    return { success: true, ...(await deltaKeyStatus(userId(request))) };
  });

  fastify.delete('/credentials', authOnly, async (request) => ({ success: true, removed: await deleteDeltaKey(userId(request)) }));
};
