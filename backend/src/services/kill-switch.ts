/**
 * Kill Switch and Admin Feature Flag Service (Task T2.8)
 *
 * Rules:
 * - ENABLE_ADMIN_KILL_SWITCH must default to false in all environments.
 * - Global deskHalted boolean tracks whether the desk is halted.
 * - While deskHalted=true: all /api/v1/fills/ingest calls return 503 {"error":"desk_halted"}.
 */

export interface DeskConfig {
  enableAdminKillSwitch: boolean;
}

/**
 * Returns backend configuration for feature flags.
 * ENABLE_ADMIN_KILL_SWITCH defaults strictly to false in all environments.
 */
export function getDeskConfig(): DeskConfig {
  return {
    enableAdminKillSwitch: process.env.ENABLE_ADMIN_KILL_SWITCH === 'true',
  };
}

/**
 * Feature flag gate check: returns true ONLY when ENABLE_ADMIN_KILL_SWITCH === 'true'.
 * Defaults to false if unset, empty, or set to any other string.
 */
export function isAdminKillSwitchEnabled(): boolean {
  return process.env.ENABLE_ADMIN_KILL_SWITCH === 'true';
}

/**
 * Global in-memory desk halt state.
 */
let deskHalted = false;

/**
 * Check if the desk is currently halted.
 */
export function isDeskHalted(): boolean {
  return deskHalted;
}

/**
 * Set the desk halted state.
 */
export function setDeskHalted(halted: boolean): void {
  deskHalted = Boolean(halted);
}

/**
 * Reset the desk halted state back to false (running).
 */
export function resetDeskHalted(): void {
  deskHalted = false;
}
