import { pool } from '../db/index.js';

export const MIN_DELTA = 0.10;
export const MAX_DELTA = 0.15;

export interface StrikeCandidate {
  strike: number;
  delta: number;
  iv?: number;
  symbol?: string;
  price?: number;
}

export interface ShadowCohort {
  id?: string;
  cohort_hour: string;
  call_strike: number;
  put_strike: number;
  call_entry_iv: number;
  put_entry_iv: number;
  call_delta: number;
  put_delta: number;
  spot_at_entry: number;
  confidence_score: number;
  status: 'open' | 'closed';
  closed_at?: string | null;
  pnl_usd?: number | null;
  raw?: Record<string, unknown> | null;
  created_at?: string;
}

export interface ConfidenceInput {
  cohort_age_hours: number;
  current_iv: number;
  max_iv_last_30d: number;
  current_delta: number;
  entry_delta: number;
}

export interface CreateCohortInput {
  cohort_hour?: Date | string;
  call: StrikeCandidate;
  put: StrikeCandidate;
  spot_at_entry: number;
  max_iv_last_30d?: number;
  raw?: Record<string, unknown>;
}

export interface UpdateMetricsInput {
  cohort: ShadowCohort;
  current_spot?: number;
  call_mark_price?: number;
  put_mark_price?: number;
  call_current_iv: number;
  put_current_iv: number;
  call_current_delta: number;
  put_current_delta: number;
  now?: Date | string;
  max_iv_last_30d?: number;
  current_pnl?: number;
}

export interface ShadowCohortMetrics {
  current_pnl: number;
  current_iv: number;
  elapsed_minutes: number;
  confidence_score: number;
}

/**
 * Checks whether delta magnitude lies within the strict [0.10, 0.15] band.
 */
export function isDeltaInBand(delta: number): boolean {
  const mag = Math.abs(delta);
  return mag >= MIN_DELTA - 1e-9 && mag <= MAX_DELTA + 1e-9;
}

/**
 * Strike selection rule: exactly 0.10–0.15 delta.
 * If a strike is outside this band, log a NO entry and skip — returns null.
 */
export function validateStrike(candidate: StrikeCandidate): StrikeCandidate | null {
  const mag = Math.abs(candidate.delta);
  if (mag < MIN_DELTA - 1e-9 || mag > MAX_DELTA + 1e-9) {
    console.info(`[ShadowStrangle] NO entry: strike ${candidate.strike} with delta ${candidate.delta} is outside [0.10, 0.15] band`);
    return null;
  }
  return candidate;
}

/**
 * Confidence score formula:
 * min(100, (cohort_age_hours * 10) + (iv_rank * 50) + (delta_stability * 40))
 * where:
 *   iv_rank = current_iv / max_iv_last_30d (0–1)
 *   delta_stability = 1 - abs(current_delta - entry_delta)
 */
export function computeConfidenceScore(params: ConfidenceInput): number {
  const ageHours = Math.max(0, params.cohort_age_hours);
  const ivRank = params.max_iv_last_30d > 0
    ? Math.min(1, Math.max(0, params.current_iv / params.max_iv_last_30d))
    : 0;
  const deltaStability = 1 - Math.abs(params.current_delta - params.entry_delta);

  const rawScore = (ageHours * 10) + (ivRank * 50) + (deltaStability * 40);
  return Math.min(100, Math.max(0, Number(rawScore.toFixed(4))));
}

/**
 * Creates an hourly virtual shadow cohort.
 * Cohort opens at the top of each hour (00 minutes).
 * Rejects with null and logs NO if either leg is outside 0.10–0.15 delta.
 */
export function createShadowCohort(input: CreateCohortInput): ShadowCohort | null {
  const validCall = validateStrike(input.call);
  if (!validCall) {
    console.info(`[ShadowStrangle] NO entry: Call strike ${input.call.strike} with delta ${input.call.delta} rejected`);
    return null;
  }

  const validPut = validateStrike(input.put);
  if (!validPut) {
    console.info(`[ShadowStrangle] NO entry: Put strike ${input.put.strike} with delta ${input.put.delta} rejected`);
    return null;
  }

  // Top of the hour (00 minutes, 00 seconds, 000 ms)
  const d = input.cohort_hour ? new Date(input.cohort_hour) : new Date();
  d.setUTCMinutes(0, 0, 0);
  d.setUTCMilliseconds(0);

  const callEntryIv = input.call.iv ?? 0;
  const putEntryIv = input.put.iv ?? 0;
  const avgEntryIv = (callEntryIv + putEntryIv) / 2;

  const confidence = computeConfidenceScore({
    cohort_age_hours: 0,
    current_iv: avgEntryIv,
    max_iv_last_30d: input.max_iv_last_30d ?? Math.max(avgEntryIv, 1),
    current_delta: Math.abs(validCall.delta),
    entry_delta: Math.abs(validCall.delta),
  });

  return {
    cohort_hour: d.toISOString(),
    call_strike: validCall.strike,
    put_strike: validPut.strike,
    call_entry_iv: callEntryIv,
    put_entry_iv: putEntryIv,
    call_delta: validCall.delta,
    put_delta: validPut.delta,
    spot_at_entry: input.spot_at_entry,
    confidence_score: confidence,
    status: 'open',
    raw: input.raw ?? null,
  };
}

/**
 * Updates 15-minute metrics for an existing shadow cohort:
 * - current_pnl
 * - current_iv
 * - elapsed_minutes
 * - updated confidence_score
 */
export function updateCohortMetrics(input: UpdateMetricsInput): ShadowCohortMetrics {
  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const entryMs = new Date(input.cohort.cohort_hour).getTime();
  const elapsed_minutes = Math.max(0, Math.floor((nowMs - entryMs) / 60000));
  const cohort_age_hours = elapsed_minutes / 60;

  const current_iv = (input.call_current_iv + input.put_current_iv) / 2;

  let current_pnl = input.current_pnl ?? 0;
  if (input.current_pnl === undefined && input.call_mark_price !== undefined && input.put_mark_price !== undefined) {
    const callEntryPrice = input.cohort.call_strike * 0.01;
    const putEntryPrice = input.cohort.put_strike * 0.01;
    current_pnl = (callEntryPrice - input.call_mark_price) + (putEntryPrice - input.put_mark_price);
  }

  const confidence_score = computeConfidenceScore({
    cohort_age_hours,
    current_iv,
    max_iv_last_30d: input.max_iv_last_30d ?? 1.0,
    current_delta: Math.abs(input.call_current_delta),
    entry_delta: Math.abs(input.cohort.call_delta),
  });

  return {
    current_pnl: Number(current_pnl.toFixed(4)),
    current_iv: Number(current_iv.toFixed(4)),
    elapsed_minutes,
    confidence_score,
  };
}

// In-memory shadow cohorts store for testing or offline mode
const inMemoryStore: ShadowCohort[] = [];

export function clearInMemoryShadowCohorts(): void {
  inMemoryStore.length = 0;
}

export function addInMemoryShadowCohort(cohort: ShadowCohort): void {
  inMemoryStore.unshift(cohort);
}

let schemaReady: Promise<void> | null = null;

export async function ensureShadowStrangleSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS shadow_strangles (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          cohort_hour timestamptz NOT NULL,
          call_strike numeric NOT NULL,
          put_strike numeric NOT NULL,
          call_entry_iv numeric NOT NULL,
          put_entry_iv numeric NOT NULL,
          call_delta numeric NOT NULL,
          put_delta numeric NOT NULL,
          spot_at_entry numeric NOT NULL,
          confidence_score numeric NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'open',
          closed_at timestamptz,
          pnl_usd numeric,
          raw jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_shadow_cohort ON shadow_strangles(cohort_hour DESC);
      `);
    })();
  }
  return schemaReady;
}

export async function saveShadowCohort(cohort: ShadowCohort): Promise<ShadowCohort> {
  addInMemoryShadowCohort(cohort);
  try {
    await ensureShadowStrangleSchema();
    const res = await pool.query(
      `INSERT INTO shadow_strangles (
        cohort_hour, call_strike, put_strike, call_entry_iv, put_entry_iv,
        call_delta, put_delta, spot_at_entry, confidence_score, status, closed_at, pnl_usd, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        cohort.cohort_hour,
        cohort.call_strike,
        cohort.put_strike,
        cohort.call_entry_iv,
        cohort.put_entry_iv,
        cohort.call_delta,
        cohort.put_delta,
        cohort.spot_at_entry,
        cohort.confidence_score,
        cohort.status,
        cohort.closed_at ?? null,
        cohort.pnl_usd ?? null,
        cohort.raw ? JSON.stringify(cohort.raw) : null,
      ]
    );
    const row = res.rows[0];
    return {
      id: row.id,
      cohort_hour: new Date(row.cohort_hour).toISOString(),
      call_strike: Number(row.call_strike),
      put_strike: Number(row.put_strike),
      call_entry_iv: Number(row.call_entry_iv),
      put_entry_iv: Number(row.put_entry_iv),
      call_delta: Number(row.call_delta),
      put_delta: Number(row.put_delta),
      spot_at_entry: Number(row.spot_at_entry),
      confidence_score: Number(row.confidence_score),
      status: row.status,
      closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
      pnl_usd: row.pnl_usd !== null ? Number(row.pnl_usd) : null,
      raw: row.raw,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    };
  } catch {
    return cohort;
  }
}

export async function getShadowCohorts(options?: { status?: string; limit?: number }): Promise<ShadowCohort[]> {
  const limit = options?.limit ?? 24;
  const statusFilter = options?.status;

  try {
    await ensureShadowStrangleSchema();
    let query = 'SELECT * FROM shadow_strangles';
    const params: any[] = [];
    if (statusFilter) {
      query += ' WHERE status = $1';
      params.push(statusFilter);
    }
    query += ` ORDER BY cohort_hour DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const res = await pool.query(query, params);
    if (res.rows.length > 0) {
      return res.rows.map((row) => ({
        id: row.id,
        cohort_hour: new Date(row.cohort_hour).toISOString(),
        call_strike: Number(row.call_strike),
        put_strike: Number(row.put_strike),
        call_entry_iv: Number(row.call_entry_iv),
        put_entry_iv: Number(row.put_entry_iv),
        call_delta: Number(row.call_delta),
        put_delta: Number(row.put_delta),
        spot_at_entry: Number(row.spot_at_entry),
        confidence_score: Number(row.confidence_score),
        status: row.status,
        closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
        pnl_usd: row.pnl_usd !== null ? Number(row.pnl_usd) : null,
        raw: row.raw,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
      }));
    }
  } catch {}

  // Fallback to in-memory store
  let filtered = [...inMemoryStore];
  if (statusFilter) {
    filtered = filtered.filter((c) => c.status === statusFilter);
  }
  return filtered.slice(0, limit);
}
