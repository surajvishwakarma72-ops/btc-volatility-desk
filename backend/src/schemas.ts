import { z } from 'zod';

export const listQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const idParam = z.object({ id: z.string().uuid() });
export const dateParam = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// trades
export const tradeCreate = z.object({
  callStrike: z.union([z.number(), z.string()]),
  putStrike: z.union([z.number(), z.string()]),
  expiryDate: z.string(),
}).passthrough();
export const tradePatch = z.object({}).passthrough();

// nights
export const nightCreate = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verdict: z.enum(['SELL_FULL', 'SELL_HALF', 'NO_TRADE']),
}).passthrough();
export const nightsQuery = z.object({
  verdict: z.string().optional(),
  outcome: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// drawings
export const drawingCreate = z.object({
  points: z.array(z.any()).min(1),
}).passthrough();
export const drawingUpdate = z.object({}).passthrough();
export const drawingsQuery = z.object({ symbol: z.string().optional() });

// preferences
export const preferencesUpdate = z.object({}).passthrough();

// alerts
export const alertRuleCreate = z.object({
  ruleName: z.string().min(1),
  ruleType: z.string().min(1),
  thresholdValue: z.union([z.number(), z.string()]),
}).passthrough();
export const alertsHistoryQuery = z.object({
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export const alertTest = z.object({
  channel: z.enum(['telegram', 'ntfy', 'in_app']).optional(),
  topic: z.string().optional(),
}).passthrough();
export const registerDevice = z.object({
  token: z.string().min(1),
  platform: z.string().optional(),
  soundChoice: z.string().optional(),
  enabled: z.boolean().optional(),
}).passthrough();

// market
export const candlesQuery = z.object({
  symbol: z.string().optional(),
  interval: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export const flowQuery = z.object({
  symbol: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export const indicatorsQuery = flowQuery;

// telemetry
export const telemetrySession = z.object({
  sessionDate: z.string(),
  uiState: z.object({}).passthrough(),
}).passthrough();
export const telemetryCheckQuery = z.object({
  timeMs: z.string().optional(),
  speed: z.string().optional(),
});
