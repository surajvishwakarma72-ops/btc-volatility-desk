import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db, userPreferences } from '../db/index.js';
import { preferencesUpdate } from '../schemas.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * User Preferences & Workspace Settings Routes
 * 
 * Endpoints:
 * - GET /api/v1/preferences           Get user theme, enabled fx indicators, and UI layout
 * - PUT /api/v1/preferences           Update workspace preferences
 */
export const preferenceRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/preferences - Retrieve preferences
  fastify.get('/', async () => {
    const prefs = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, DEFAULT_USER_ID))
      .limit(1);

    if (!prefs.length) {
      // Default fallback if no record exists yet
      return {
        success: true,
        data: {
          theme: 'coinglass_dark',
          activeIndicators: ['volturn', 'term_structure', 'iv_rv_spread'],
          chartLayout: {},
          riskLimits: {},
        },
      };
    }

    return {
      success: true,
      data: prefs[0],
    };
  });

  // PUT /api/v1/preferences - Save / update preferences
  fastify.put('/', { schema: { body: preferencesUpdate } }, async (request) => {
    const body = request.body as any;

    const newPrefs = {
      id: crypto.randomUUID(),
      userId: DEFAULT_USER_ID,
      theme: body.theme || 'coinglass_dark',
      activeIndicators: Array.isArray(body.activeIndicators) ? body.activeIndicators : [],
      chartLayout: body.chartLayout || {},
      riskLimits: body.riskLimits || {},
      updatedAt: new Date(),
    };

    const saved = await db
      .insert(userPreferences)
      .values(newPrefs)
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          theme: sql`coalesce(excluded.theme, user_preferences.theme)`,
          activeIndicators: sql`coalesce(excluded.active_indicators, user_preferences.active_indicators)`,
          chartLayout: sql`coalesce(excluded.chart_layout, user_preferences.chart_layout)`,
          riskLimits: sql`coalesce(excluded.risk_limits, user_preferences.risk_limits)`,
          updatedAt: new Date(),
        },
      })
      .returning();

    return {
      success: true,
      data: saved[0],
    };
  });
};
