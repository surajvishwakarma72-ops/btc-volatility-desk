import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { computeGreekPnl, type PositionInput } from '../services/greek-pnl.js';
import { getSessionPnl } from '../services/session-pnl.js';
import { isTokenRevoked, sessionStillValid } from '../services/session-guard.js';
import { DESK_USER_ID } from '../services/auth-store.js';
import { paperFor } from '../services/paper/paper-terminal.js';

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
    if (token) return token.replace(/^["']|["']$/g, '');
  }
  const authHeader = request.headers.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

type PositionLookupFn = (userId: string, symbol: string) => Promise<PositionInput | null> | PositionInput | null;
let customLookupProvider: PositionLookupFn | null = null;

export function setPositionLookupProvider(fn: PositionLookupFn | null): void {
  customLookupProvider = fn;
}

const querySchema = z.object({
  symbol: z.string().trim().min(1, 'symbol query parameter is required'),
  quantity: z.coerce.number().optional(),
  contract_value: z.coerce.number().optional(),
  delta: z.coerce.number().optional(),
  gamma: z.coerce.number().optional(),
  theta: z.coerce.number().optional(),
  vega: z.coerce.number().optional(),
  delta_spot: z.coerce.number().optional(),
  delta_vol: z.coerce.number().optional(),
  elapsed_seconds: z.coerce.number().optional(),
  total_pnl: z.coerce.number().optional(),
  current_spot: z.coerce.number().optional(),
  entry_spot: z.coerce.number().optional(),
  current_iv: z.coerce.number().optional(),
  entry_iv: z.coerce.number().optional(),
});

export const pnlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/greek', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Session check
    const token = getSessionToken(request);
    if (!token) {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Session required' });
    }

    if (isTokenRevoked(token)) {
      return reply.status(401).send({ success: false, error: 'Session invalidated. Please log in again.' });
    }

    let decoded: any = null;
    try {
      decoded = fastify.jwt.verify(token);
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid session token' });
    }

    if (!decoded) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const userId = decoded.sub || decoded.id || DESK_USER_ID;
    if (!(await sessionStillValid(userId, decoded.iat))) {
      return reply.status(401).send({ success: false, error: 'Your password was changed. Sign in again.' });
    }

    // 2. Validate query params
    const parseRes = querySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        success: false,
        error: 'symbol query parameter is required',
        details: parseRes.error.flatten(),
      });
    }

    const q = parseRes.data;
    const symbol = q.symbol;

    // 3. Resolve position data
    let basePosition: PositionInput | null = null;
    if (customLookupProvider) {
      try {
        basePosition = await customLookupProvider(userId, symbol);
      } catch {}
    } else {
      // Default lookup from user's active paper positions
      try {
        const paper = paperFor(userId);
        const acct: any = await paper.account();
        if (acct && Array.isArray(acct.positions) && acct.positions.length > 0) {
          const match: any = acct.positions.find((p: any) => p.symbol && p.symbol.toLowerCase() === symbol.toLowerCase())
            || (symbol.toUpperCase() === 'BTC' || symbol.toUpperCase() === 'ALL' ? acct.positions[0] : null);
          if (match) {
            const isPerp = match.kind === 'perp' || match.symbol.includes('USD') || match.symbol.includes('PERP');
            const spotMark = (acct.spot && typeof acct.spot === 'object' && acct.spot.mark)
              || (typeof acct.spot === 'number' ? acct.spot : null)
              || (isPerp ? (match.mark || match.avgEntry) : null);
            const deltaSpot = isPerp && spotMark && match.avgEntry
              ? (spotMark - match.avgEntry)
              : (q.delta_spot !== undefined ? q.delta_spot : 0);
            const g: any = acct.greeks || {};
            const elapsedSec = match.openedAt ? Math.max(1, Math.round((Date.now() - match.openedAt) / 1000)) : 60;
            basePosition = {
              symbol: match.symbol,
              quantity: match.lots,
              contract_value: match.contract_value ?? 0.001,
              delta: match.delta != null ? match.delta : (isPerp ? 1 : (g.delta ?? 0)),
              gamma: isPerp ? 0 : (g.gamma ?? 0),
              theta: isPerp ? 0 : (g.theta ?? 0),
              vega: isPerp ? 0 : (g.vega ?? 0),
              delta_spot: deltaSpot,
              current_spot: spotMark,
              entry_spot: isPerp ? match.avgEntry : spotMark,
              total_pnl: match.unrealized ?? 0,
              elapsed_seconds: elapsedSec,
            };
          }
        }
      } catch (err) {
        request.log?.warn({ err }, 'Failed to resolve default paper position for greek pnl');
      }
    }

    const posInput: PositionInput = {
      symbol,
      quantity: q.quantity !== undefined ? q.quantity : (basePosition?.quantity ?? 0),
      contract_value: q.contract_value !== undefined ? q.contract_value : (basePosition?.contract_value ?? 0.001),
      delta: q.delta !== undefined ? q.delta : (basePosition?.delta ?? 0),
      gamma: q.gamma !== undefined ? q.gamma : (basePosition?.gamma ?? 0),
      theta: q.theta !== undefined ? q.theta : (basePosition?.theta ?? 0),
      vega: q.vega !== undefined ? q.vega : (basePosition?.vega ?? 0),
      delta_spot: q.delta_spot !== undefined ? q.delta_spot : (basePosition?.delta_spot ?? 0),
      delta_vol: q.delta_vol !== undefined ? q.delta_vol : (basePosition?.delta_vol ?? 0),
      current_spot: q.current_spot !== undefined ? q.current_spot : basePosition?.current_spot,
      entry_spot: q.entry_spot !== undefined ? q.entry_spot : basePosition?.entry_spot,
      current_iv: q.current_iv !== undefined ? q.current_iv : basePosition?.current_iv,
      entry_iv: q.entry_iv !== undefined ? q.entry_iv : basePosition?.entry_iv,
      elapsed_seconds: q.elapsed_seconds !== undefined ? q.elapsed_seconds : (basePosition?.elapsed_seconds ?? 60),
      total_pnl: q.total_pnl !== undefined ? q.total_pnl : (basePosition?.total_pnl ?? 0),
    };

    const res = computeGreekPnl(posInput);

    return reply.status(200).send({
      success: true,
      symbol: res.symbol,
      delta_pnl: res.delta_pnl,
      gamma_pnl: res.gamma_pnl,
      theta_pnl: res.theta_pnl,
      vega_pnl: res.vega_pnl,
      other_pnl: res.other_pnl,
      total_pnl: res.total_pnl,
    });
  });

  // GET /api/v1/pnl/session — returns today's aggregated P&L from fills table (Task T4.3)
  fastify.get('/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = getSessionToken(request);
    if (!token || isTokenRevoked(token)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Session required' });
    }
    let decoded: any = null;
    try {
      decoded = fastify.jwt.verify(token);
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid session token' });
    }
    const uid = decoded?.sub || decoded?.id || DESK_USER_ID;
    if (!(await sessionStillValid(uid, decoded?.iat))) {
      return reply.status(401).send({ success: false, error: 'Session invalidated' });
    }

    try {
      const query = (request.query || {}) as { since?: string; date?: string; account?: string };
      const since = query.since || query.date;
      const result = await getSessionPnl(uid, since, query.account);
      return reply.status(200).send({
        total_pnl: result.total_pnl,
        delta_pnl: result.delta_pnl,
        gamma_pnl: result.gamma_pnl,
        theta_pnl: result.theta_pnl,
        vega_pnl: result.vega_pnl,
        other_pnl: result.other_pnl,
        fill_count: result.fill_count,
      });
    } catch (err: any) {
      request.log?.error(err);
      return reply.status(500).send({
        error: err.message || 'Failed to aggregate session P&L',
      });
    }
  });
};

