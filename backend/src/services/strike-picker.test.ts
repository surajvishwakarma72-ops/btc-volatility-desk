import { describe, expect, it, vi } from 'vitest';
import { pickBodyLeg, type ChainOption } from '../lib/bot/strike-picker.js';

const EXP = 1_700_000_000_000;

function createOpt(delta: number, symbol = `C-${delta}`, type: 'call' | 'put' = 'call'): ChainOption {
  return {
    symbol,
    type,
    strike: 80000,
    expiryMs: EXP,
    delta,
    bid: 10,
    ask: 12,
    mark: 11,
    iv: 0.5,
  };
}

describe('Strict Strike Picker Delta Band [0.10, 0.15] (Task T2.6)', () => {
  it('a. delta = 0.09 is rejected and logs NO', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chain: ChainOption[] = [createOpt(0.09, 'C-0.09')];
    const picked = pickBodyLeg(chain, 'call', EXP);
    expect(picked).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    const loggedMessage = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(loggedMessage).toContain('NO');
    expect(loggedMessage).toContain('0.09');
    warnSpy.mockRestore();
  });

  it('b. delta = 0.10 is accepted (exact lower boundary)', () => {
    const chain: ChainOption[] = [createOpt(0.10, 'C-0.10')];
    const picked = pickBodyLeg(chain, 'call', EXP);
    expect(picked).not.toBeNull();
    expect(picked?.symbol).toBe('C-0.10');
    expect(picked?.delta).toBe(0.10);
  });

  it('c. delta = 0.15 is accepted (exact upper boundary)', () => {
    const chain: ChainOption[] = [createOpt(0.15, 'C-0.15')];
    const picked = pickBodyLeg(chain, 'call', EXP);
    expect(picked).not.toBeNull();
    expect(picked?.symbol).toBe('C-0.15');
    expect(picked?.delta).toBe(0.15);
  });

  it('d. delta = 0.16 is rejected and logs NO', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chain: ChainOption[] = [createOpt(0.16, 'C-0.16')];
    const picked = pickBodyLeg(chain, 'call', EXP);
    expect(picked).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    const loggedMessage = warnSpy.mock.calls.map((c) => c.join(' ')).join(' ');
    expect(loggedMessage).toContain('NO');
    expect(loggedMessage).toContain('0.16');
    warnSpy.mockRestore();
  });

  it('e. delta = 0.12 is accepted (middle of band)', () => {
    const chain: ChainOption[] = [createOpt(0.12, 'C-0.12')];
    const picked = pickBodyLeg(chain, 'call', EXP);
    expect(picked).not.toBeNull();
    expect(picked?.symbol).toBe('C-0.12');
    expect(picked?.delta).toBe(0.12);
  });
});

