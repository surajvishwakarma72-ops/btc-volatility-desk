/**
 * Core Domain TypeScript Type Definitions.
 *
 * Domain types are introduced alongside the features that need them (route Zod
 * schemas in `src/schemas.ts`, Drizzle row types inferred from `src/db/schema.ts`).
 * Shared cross-cutting types live here; `BaseEntity` is the common id/timestamp shape.
 */

export interface BaseEntity {
  id: string;
  createdAt: string;
  updatedAt?: string;
}
