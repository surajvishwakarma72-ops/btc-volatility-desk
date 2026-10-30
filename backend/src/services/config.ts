/**
 * Backend Configuration & Feature Flags (Task T2.8)
 *
 * Rules:
 * - ENABLE_ADMIN_KILL_SWITCH must default to false in all environments.
 */

export const config = {
  /**
   * Admin kill switch feature flag.
   * Defaults to false in all environments unless explicitly set to 'true'.
   */
  get ENABLE_ADMIN_KILL_SWITCH(): boolean {
    return process.env.ENABLE_ADMIN_KILL_SWITCH === 'true';
  },
};

export function isFeatureFlagEnabled(flagName: string): boolean {
  if (flagName === 'ENABLE_ADMIN_KILL_SWITCH') {
    return config.ENABLE_ADMIN_KILL_SWITCH;
  }
  return process.env[flagName] === 'true';
}
