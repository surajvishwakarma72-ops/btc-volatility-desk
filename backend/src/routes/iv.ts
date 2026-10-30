import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { recordIvSnapshot, getIvRank } from '../services/iv-rank.js';

interface RecordBody {
  expiry_label: string;
  mark_vol: number | string;
}

interface RankQuery {
  expiry_label?: string;
  expiry?: string;
  current_iv?: string | number;
}

export const ivRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/v1/iv/record — inserts a mark_vol snapshot (body: {expiry_label, mark_vol})
  fastify.post('/record', async (request: FastifyRequest<{ Body: RecordBody }>, reply: FastifyReply) => {
    const body = request.body;
    if (!body || !body.expiry_label || body.mark_vol === undefined || body.mark_vol === null) {
      return reply.status(400).send({
        success: false,
        error: 'expiry_label and mark_vol are required',
      });
    }

    const markVol = Number(body.mark_vol);
    if (isNaN(markVol)) {
      return reply.status(400).send({
        success: false,
        error: 'mark_vol must be a valid number',
      });
    }

    try {
      const row = await recordIvSnapshot(body.expiry_label, markVol);
      return reply.status(200).send({
        success: true,
        id: row.id,
        expiry_label: row.expiry_label,
        mark_vol: row.mark_vol,
        recorded_at: row.recorded_at,
        data: row,
      });
    } catch (err: any) {
      request.log?.error(err);
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to record IV snapshot',
      });
    }
  });

  // GET /api/v1/iv/rank?expiry_label=X — returns {expiry_label, current_iv, iv_rank, sample_size}
  fastify.get('/rank', async (request: FastifyRequest<{ Querystring: RankQuery }>, reply: FastifyReply) => {
    const query = (request.query || {}) as RankQuery;
    const label = query.expiry_label || query.expiry;

    if (!label) {
      return reply.status(400).send({
        success: false,
        error: 'expiry_label query parameter is required',
      });
    }

    const overrideIv = query.current_iv !== undefined ? Number(query.current_iv) : undefined;
    if (overrideIv !== undefined && isNaN(overrideIv)) {
      return reply.status(400).send({
        success: false,
        error: 'current_iv must be a valid number if provided',
      });
    }

    try {
      const result = await getIvRank(label, undefined, overrideIv);
      return reply.status(200).send({
        expiry_label: result.expiry_label,
        current_iv: result.current_iv,
        iv_rank: result.iv_rank,
        sample_size: result.sample_size,
        success: true,
      });
    } catch (err: any) {
      request.log?.error(err);
      return reply.status(500).send({
        success: false,
        error: err.message || 'Failed to compute IV rank',
      });
    }
  });
};
