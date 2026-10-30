import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { isTokenRevoked, sessionStillValid } from '../services/session-guard.js';

let schemaReady: Promise<void> | null = null;

export async function ensureFeedbackSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS desk_feedback (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid REFERENCES users(id),
          category varchar(10) NOT NULL,
          message text NOT NULL,
          submitted_at timestamptz DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_desk_feedback_user ON desk_feedback(user_id);
        CREATE INDEX IF NOT EXISTS idx_desk_feedback_submitted ON desk_feedback(submitted_at);
      `);
    })();
  }
  return schemaReady;
}

export function resetFeedbackSchemaCache(): void {
  schemaReady = null;
}

function parseCookies(header: string | undefined): Record<string, string> {
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

const feedbackSchema = z.object({
  category: z.enum(['bug', 'idea', 'other'], {
    errorMap: () => ({ message: "Category is required and must be 'bug', 'idea', or 'other'" }),
  }),
  message: z.string({
    required_error: 'Message is required',
    invalid_type_error: 'Message must be text',
  }).trim().min(1, 'Message is required').max(1000, 'Message cannot exceed 1000 characters'),
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * User Feedback Route (Task T1.6)
 *
 * POST /api/v1/feedback
 * Body: { message: string, category: 'bug' | 'idea' | 'other' }
 * Requires authenticated session.
 * Stores feedback in desk_feedback and returns 201.
 */
export const feedbackRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', async (request: FastifyRequest, reply: FastifyReply) => {
    // Disallow token passing via query string
    if (request.query && typeof request.query === 'object' && ('token' in request.query || 'jwt' in request.query || 'authorization' in request.query)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Query string tokens not accepted' });
    }

    // 1. Session verification
    const token = getSessionToken(request);
    if (!token) {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Session required' });
    }

    if (isTokenRevoked(token)) {
      return reply.status(401).send({ success: false, error: 'Session invalidated. Please log in again.' });
    }

    let decodedUser: { sub?: string; id?: string; role?: string; email?: string; iat?: number } | null = null;
    try {
      decodedUser = (fastify as any).jwt.verify(token);
    } catch {
      return reply.status(401).send({ success: false, error: 'Invalid session token' });
    }

    if (!decodedUser) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    const userId = decodedUser.sub || decodedUser.id;
    if (!(await sessionStillValid(userId, decodedUser.iat))) {
      return reply.status(401).send({ success: false, error: 'Session invalidated' });
    }

    // 2. Request body validation
    const parsed = feedbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return reply.status(400).send({
        success: false,
        error: firstIssue?.message || 'Invalid feedback payload',
      });
    }

    // 3. Database persistence
    await ensureFeedbackSchema();

    const dbUserId = userId && UUID_REGEX.test(userId) ? userId : null;

    const result = await pool.query(
      `INSERT INTO desk_feedback (user_id, category, message, submitted_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, user_id, category, message, submitted_at`,
      [dbUserId, parsed.data.category, parsed.data.message]
    );

    const row = result.rows[0];

    return reply.status(201).send({
      success: true,
      id: row.id,
      feedback: {
        id: row.id,
        userId: row.user_id,
        category: row.category,
        message: row.message,
        submittedAt: row.submitted_at,
      },
    });
  });
};

