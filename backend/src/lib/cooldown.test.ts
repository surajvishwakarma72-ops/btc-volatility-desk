import { describe, it, expect } from 'vitest';
import { CooldownGate } from './cooldown.js';

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
