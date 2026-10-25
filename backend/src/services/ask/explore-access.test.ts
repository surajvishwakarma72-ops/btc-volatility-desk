import { describe, expect, it } from 'vitest';
import { hiddenFor } from './explore.js';

describe('what a friend may browse through Ask', () => {
  it('hides every personal and owner-only table from a friend, and nothing from the owner except secrets', () => {
    for (const t of ['trades', 'paper_account', 'paper_positions', 'paper_fills', 'ask_notes', 'alert_rules', 'user_preferences', 'some_future_table']) {
      expect(hiddenFor(t, false), t).toBe(true);
      expect(hiddenFor(t, true), t).toBe(false);
      expect(hiddenFor(t, undefined), t).toBe(false);
    }
    for (const t of ['bot_runs', 'bot_events', 'market_timeseries', 'indicator_snapshots', 'macro_stress_points']) expect(hiddenFor(t, false), t).toBe(false);
    for (const t of ['users', 'desk_delta_keys', 'desk_invites', 'api_credentials', 'push_devices']) {
      expect(hiddenFor(t, true), t).toBe(true); // secrets are hidden from everybody
      expect(hiddenFor(t, false), t).toBe(true);
    }
  });
});
