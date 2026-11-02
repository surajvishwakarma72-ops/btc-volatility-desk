import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { deskEvents } from '../services/desk-events.js';
import { isTokenRevoked, sessionStillValid } from '../services/session-guard.js';
import { DESK_USER_ID } from '../services/auth-store.js';
import { accountReader, type AccountState } from '../services/account-state.js';
import { isDeskHalted } from '../services/kill-switch.js';

function parseCookies(header?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!header) return list;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) list[k] = decodeURIComponent(v.join('='));
  }
  return list;
}

function getSessionToken(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const token = cookies.desk_token || cookies.session_token || cookies.token;
    if (token) return token;
  }
  const authHeader = request.headers.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

const MAX_BUFFERED_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30_000;

/** Skips a push when the client has not read the last ones, so a slow or sleeping device cannot pile data up in server memory. */
export function canSend(socket: Pick<WebSocket, 'readyState' | 'bufferedAmount'>): boolean {
  return socket.readyState === 1 && socket.bufferedAmount < MAX_BUFFERED_BYTES;
}

// User connection tracker: max 10 concurrent connections per user session
const userConnections = new Map<string, Set<WebSocket>>();

export function getActiveConnectionCount(userId?: string): number {
  if (userId) return userConnections.get(userId)?.size || 0;
  let total = 0;
  for (const conns of userConnections.values()) total += conns.size;
  return total;
}

export function resetActiveConnections(): void {
  for (const conns of userConnections.values()) {
    for (const ws of conns) {
      try { ws.close(); } catch {}
    }
  }
  userConnections.clear();
}

/**
 * Broadcast kill switch status to all active WebSocket connections.
 */
export function broadcastKillSwitch(halted: boolean = true): void {
  const payload = JSON.stringify({ type: 'KILL_SWITCH', halted });
  for (const conns of userConnections.values()) {
    for (const ws of conns) {
      if (ws.readyState === 1) { // 1 === WebSocket.OPEN
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }
}

/**
 * Broadcast strike alert to all active WebSocket connections.
 */
export function broadcastStrikeAlert(alert: Record<string, unknown>): void {
  const payload = JSON.stringify({
    type: 'strike_alert',
    event: 'alert',
    alert,
    data: alert,
    ...alert,
  });
  for (const conns of userConnections.values()) {
    for (const ws of conns) {
      if (ws.readyState === 1) { // 1 === WebSocket.OPEN
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }
}

type PositionsProvider = (userId: string) => Promise<AccountState[]> | AccountState[];
type TickersProvider = () => Promise<any[]> | any[];

let customPositionsProvider: PositionsProvider | null = null;
let customTickersProvider: TickersProvider | null = null;

export function setWsPositionsProvider(fn: PositionsProvider | null): void {
  customPositionsProvider = fn;
}

export function setWsTickersProvider(fn: TickersProvider | null): void {
  customTickersProvider = fn;
}

let cachedTickers: any[] = [];
let lastTickersFetch = 0;

async function defaultTickersProvider(): Promise<any[]> {
  const now = Date.now();
  if (cachedTickers.length > 0 && now - lastTickersFetch < 3000) {
    return cachedTickers;
  }
  try {
    const res = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && Array.isArray((data as any).result)) {
        cachedTickers = (data as any).result;
        lastTickersFetch = now;
        return cachedTickers;
      }
    }
  } catch {}
  return cachedTickers;
}

async function getAccounts(userId: string): Promise<AccountState[]> {
  if (customPositionsProvider) return customPositionsProvider(userId);
  return accountReader.read(userId);
}

async function getTickers(): Promise<any[]> {
  if (customTickersProvider) return customTickersProvider();
  return defaultTickersProvider();
}

/**
 * Handle incoming WebSocket desk connection.
 */
async function handleWsDesk(socket: WebSocket, request: FastifyRequest, fastify: any) {
  // 1. Authenticate via session cookie
  const token = getSessionToken(request);
  if (!token) {
    socket.close(4401, 'Unauthorized');
    return;
  }

  if (isTokenRevoked(token)) {
    socket.close(4401, 'Session revoked');
    return;
  }

  let decoded: { sub?: string; id?: string; role?: string; email?: string; iat?: number } | null = null;
  try {
    decoded = fastify.jwt.verify(token);
  } catch {
    socket.close(4401, 'Invalid session token');
    return;
  }

  if (!decoded) {
    socket.close(4401, 'Unauthorized');
    return;
  }

  const userId = decoded.sub || decoded.id || DESK_USER_ID;
  if (!(await sessionStillValid(userId, decoded.iat))) {
    socket.close(4401, 'Password changed');
    return;
  }

  // 2. Enforce max 10 concurrent WS connections per user session
  let conns = userConnections.get(userId);
  if (!conns) {
    conns = new Set();
    userConnections.set(userId, conns);
  }
  if (conns.size >= 10) {
    socket.close(4429, 'Max concurrent connections reached');
    return;
  }
  conns.add(socket);

  // 3. Channels subscribed by this client
  const subscribedChannels = new Set<string>();

  const sendPositions = async () => {
    if (!canSend(socket)) return;
    try {
      const data = await getAccounts(userId);
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'accounts', data }));
      }
    } catch (err) {
      // nothing is sent, so the browser keeps its last figures instead of showing an empty account
      console.warn('[ws-desk] account read failed:', err instanceof Error ? err.message : err);
    }
  };

  const sendTickers = async () => {
    if (!canSend(socket)) return;
    try {
      const data = await getTickers();
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'tickers', data }));
      }
    } catch {}
  };

  const onFill = (fillRow: any) => {
    // a fill goes only to the user it belongs to
    if (fillRow?.user_id && fillRow.user_id !== userId) return;
    if (subscribedChannels.has('fills') && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'fill', data: fillRow }));
    }
  };

  const onKillSwitch = (halted: boolean) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'KILL_SWITCH', halted }));
    }
  };

  const onStrikeAlert = (alert: any) => {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'strike_alert',
        event: 'alert',
        alert,
        data: alert,
        ...alert,
      }));
    }
  };

  // shock alerts (news_alert / news_update / news_ack) go to every signed-in desk
  const onNews = (n: { type: string; event: unknown }) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: n.type, data: n.event }));
  };

  deskEvents.on('fill', onFill);
  deskEvents.on('kill_switch', onKillSwitch);
  deskEvents.on('strike_alert', onStrikeAlert);
  deskEvents.on('news', onNews);
  const onVol = (a: unknown) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'vol_alert', data: a })); };
  deskEvents.on('vol_alert', onVol);

  // If desk is already halted on connection, notify client immediately
  if (isDeskHalted() && socket.readyState === 1) {
    socket.send(JSON.stringify({ type: 'KILL_SWITCH', halted: true }));
  }

  // Periodic intervals: positions every 2s, tickers every 4s
  const positionsInterval = setInterval(() => {
    if (subscribedChannels.has('positions')) {
      sendPositions();
    }
  }, 2000);

  const tickersInterval = setInterval(() => {
    if (subscribedChannels.has('tickers')) {
      sendTickers();
    }
  }, 4000);

  // A sleeping phone can hold a socket open without reading it. No pong by the next ping means it is gone.
  let alive = true;
  socket.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    alive = false;
    try { socket.ping(); } catch {}
  }, HEARTBEAT_MS);

  // Clean-up handler
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(positionsInterval);
    clearInterval(tickersInterval);
    clearInterval(heartbeat);
    deskEvents.removeListener('fill', onFill);
    deskEvents.removeListener('kill_switch', onKillSwitch);
    deskEvents.removeListener('strike_alert', onStrikeAlert);
    deskEvents.removeListener('news', onNews);
    deskEvents.removeListener('vol_alert', onVol);
    conns?.delete(socket);
    if (conns && conns.size === 0) {
      userConnections.delete(userId);
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);

  // Incoming client messages
  socket.on('message', async (raw: any) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg && msg.type === 'subscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels) {
        if (typeof ch === 'string') {
          subscribedChannels.add(ch.toLowerCase().trim());
        }
      }
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'subscribed', channels: Array.from(subscribedChannels) }));
      }
      if (subscribedChannels.has('positions')) {
        sendPositions();
      }
      if (subscribedChannels.has('tickers')) {
        sendTickers();
      }
    }
  });
}

/**
 * Fastify plugin mounting the WebSocket desk endpoint.
 * Serves /ws/desk and /desk.
 */
export const wsDeskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/ws/desk', { websocket: true }, (socket, req) => handleWsDesk(socket as any, req, fastify));
  fastify.get('/desk', { websocket: true }, (socket, req) => handleWsDesk(socket as any, req, fastify));
};
