/**
 * Core Domain TypeScript Type Definitions Stub
 * 
 * Future Types:
 * - Trade, TradeEntryInput, TradeCloseInput, StranglePosition
 * - NightlyReview, NightReviewInput, DayStatistics
 * - ChartDrawing, Point, LineStyle
 * - UserPreferences, FxIndicatorSettings
 * - AlertRule, AlertPayload, PushNotificationTarget
 */

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt?: string;
}
