import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { logAudit, getAuditLogs, ensureAdminAuditSchema } from './audit-logger.js';
import { adminRoutes } from '../routes/admin.js';

describe('Admin Audit Log (Task T2.7)', () => {
  const TEST_ACTOR = '00000000-0000-0000-0000-000000000001';

  describe('logAudit service unit tests', () => {
    it('a. logAudit executes insert query with normalized parameters', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
      const mockDb = { query: mockQuery };

      await logAudit(mockDb, TEST_ACTOR, 'login', 'success', '192.168.1.1');

      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO desk_admin_audit'));
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall!;
      expect(sql).toContain('INSERT INTO desk_admin_audit');
      expect(params[0]).toBe(TEST_ACTOR);
      expect(params[1]).toBe('login');
      expect(params[2]).toBe('success');
      expect(params[3]).toBe('192.168.1.1');
    });

    it('b. action is truncated to 40 chars and result to 20 chars', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
      const mockDb = { query: mockQuery };

      const longAction = 'a'.repeat(60);
      const longResult = 'r'.repeat(40);

      await logAudit(mockDb, TEST_ACTOR, longAction, longResult, '10.0.0.1');

      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO desk_admin_audit'));
      expect(insertCall).toBeDefined();
      const [, params] = insertCall!;
      expect(params[1]).toHaveLength(40);
      expect(params[1]).toBe('a'.repeat(40));
      expect(params[2]).toHaveLength(20);
      expect(params[2]).toBe('r'.repeat(20));
    });

    it('c. logAudit never throws even if DB is unavailable (mock DB failure)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const brokenDb = {
        query: vi.fn().mockRejectedValue(new Error('connection timeout: DB unreachable')),
      };

      // Calling logAudit MUST NOT throw an unhandled rejection or error
      await expect(logAudit(brokenDb, TEST_ACTOR, 'login', 'failed', '127.0.0.1')).resolves.toBeUndefined();

      expect(brokenDb.query).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('d. logAudit never throws when db client is null, undefined, or missing query function', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(logAudit(null, TEST_ACTOR, 'action', 'ok')).resolves.toBeUndefined();
      await expect(logAudit({}, TEST_ACTOR, 'action', 'ok')).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('getAuditLogs service tests', () => {
    it('e. limit and offset params are applied to query', async () => {
      const mockQuery = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('count(*)')) {
          return Promise.resolve({ rows: [{ total: 100 }] });
        }
        return Promise.resolve({
          rows: [
            { id: '1', ts: new Date().toISOString(), actor_id: TEST_ACTOR, action: 'login', result: 'success' },
            { id: '2', ts: new Date().toISOString(), actor_id: TEST_ACTOR, action: 'logout', result: 'success' },
          ],
        });
      });
      const mockDb = { query: mockQuery };

      const result = await getAuditLogs(mockDb, { limit: 10, offset: 5, action: 'login' });

      expect(result.total).toBe(100);
      expect(result.rows).toHaveLength(2);

      const selectCall = mockQuery.mock.calls.find(([sql]) => sql.includes('SELECT id, ts'));
      expect(selectCall).toBeDefined();
      const [, params] = selectCall!;
      expect(params).toContain(10); // limit
      expect(params).toContain(5);  // offset
      expect(params).toContain('login');
    });
  });

  describe('Route GET /api/v1/admin/audit', () => {
    let app: FastifyInstance;
    let adminToken: string;
    let traderToken: string;

    const mockRows = [
      { id: 'uuid-1', ts: '2026-10-30T10:00:00Z', actor_id: TEST_ACTOR, action: 'login', result: 'success', ip: '127.0.0.1' },
      { id: 'uuid-2', ts: '2026-10-30T10:05:00Z', actor_id: TEST_ACTOR, action: 'password_reset_approve', result: 'success', ip: '127.0.0.1' },
      { id: 'uuid-3', ts: '2026-10-30T10:10:00Z', actor_id: TEST_ACTOR, action: 'fills_ingest', result: 'success', ip: '127.0.0.1' },
    ];

    beforeAll(async () => {
      app = fastify({ logger: false });
      await app.register(jwt, { secret: 'audit-test-secret-key' });
      await app.register(adminRoutes, { prefix: '/api/v1/admin' });

      adminToken = app.jwt.sign({ sub: TEST_ACTOR, role: 'admin', email: 'owner@desk.local' });
      traderToken = app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000002', role: 'trader', email: 'trader@desk.local' });
    });

    afterAll(async () => {
      await app.close();
    });

    it('f. unauthenticated request returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
      });
      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Unauthorized');
    });

    it('g. non-admin user returns 403 Forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
        headers: {
          authorization: `Bearer ${traderToken}`,
        },
      });
      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Forbidden');
    });

    it('h. authenticated admin returns 200 with audit logs list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.audit_logs)).toBe(true);
    });

    it('i. limit param respected (query parameter limit)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?limit=2',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.limit).toBe(2);
      expect(json.audit_logs.length).toBeLessThanOrEqual(2);
    });
  });
});
