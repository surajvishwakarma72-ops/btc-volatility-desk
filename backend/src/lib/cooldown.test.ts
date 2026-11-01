import { describe, it, expect } from 'vitest';
import { CooldownGate, LoginCooldownTracker } from './cooldown.js';

describe('LoginCooldownTracker', () => {
  const allowed = (t: LoginCooldownTracker) => t.check('ip', 5, 600_000).allowed;
  const attempt = (t: LoginCooldownTracker, correct: boolean) => { t.record('ip'); if (correct) t.forgetLast('ip'); };

  it('never locks out correct logins', () => {
    const t = new LoginCooldownTracker();
    for (let i = 0; i < 20; i++) attempt(t, true);
    expect(allowed(t)).toBe(true);
  });

  it('a correct login does not wipe earlier wrong guesses', () => {
    const t = new LoginCooldownTracker();
    for (let i = 0; i < 4; i++) attempt(t, false);
    attempt(t, true);
    expect(allowed(t)).toBe(true);
    attempt(t, false);
    expect(allowed(t)).toBe(false);
  });
});

describe('CooldownGate', () => {
  it('allows the first call and blocks within the cooldown', () => {
    const g = new CooldownGate();
    expect(g.allow('rule1', 1000, 5000)).toBe(true);
    expect(g.allow('rule1', 2000, 5000)).toBe(false);
    expect(g.allow('rule1', 6500, 5000)).toBe(true);
  });

  it('tracks rules independently', () => {
    const g = new CooldownGate();
    expect(g.allow('a', 0, 1000)).toBe(true);
    expect(g.allow('b', 0, 1000)).toBe(true);
  });
});
