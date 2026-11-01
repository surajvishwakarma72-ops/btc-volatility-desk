import { describe, expect, it, vi } from 'vitest';
import { AccountReader, classifyDeltaFailure, type AccountReaderDeps } from './account-state.js';
import type { DeskAccount } from './accounts.js';

const main: DeskAccount = { account: 'main', kind: 'read', creds: { key: 'K-MAIN', secret: 's' }, watchOnly: true };
const sub: DeskAccount = { account: 'sub', kind: 'trade', creds: { key: 'K-SUB', secret: 's' }, watchOnly: false };
const okBody = (symbol: string) => ({ ok: true, status: 200, body: { result: [{ product_symbol: symbol, size: -5 }] }, errorText: '' });

function reader(over: Partial<AccountReaderDeps> = {}) {
  let t = 1_000_000;
  const deps: AccountReaderDeps = {
    accounts: async () => [main, sub],
    get: vi.fn(async (key: string) => okBody(key === 'K-MAIN' ? 'C-MAIN' : 'C-SUB')),
    note: vi.fn(async () => undefined),
    now: () => t,
    ...over,
  };
  return { r: new AccountReader(deps), deps, advance: (ms: number) => { t += ms; } };
}

describe('AccountReader', () => {
  it('keeps each account on its own key and label', async () => {
    const { r } = reader();
    const [a, b] = await r.read('u');
    expect(a).toMatchObject({ account: 'main', health: 'connected', positions: [{ product_symbol: 'C-MAIN' }] });
    expect(b).toMatchObject({ account: 'sub', health: 'connected', positions: [{ product_symbol: 'C-SUB' }] });
  });

  it('reports a failed read as a failure, never as an empty account', async () => {
    const { r } = reader({ get: vi.fn(async () => ({ ok: false, status: 401, body: null, errorText: 'InvalidApiKey' })) });
    const [a] = await r.read('u');
    expect(a).toMatchObject({ health: 'auth_failed', positions: null, error: 'InvalidApiKey', lastOkAt: null });
  });

  it('treats a truly empty account as connected', async () => {
    const { r } = reader({ get: vi.fn(async () => ({ ok: true, status: 200, body: { result: [] }, errorText: '' })) });
    const [a] = await r.read('u');
    expect(a).toMatchObject({ health: 'connected', positions: [] });
  });

  it('treats a reply with no position list as unknown, not as flat', async () => {
    const { r } = reader({ get: vi.fn(async () => ({ ok: true, status: 200, body: {}, errorText: '' })) });
    expect((await r.read('u'))[0]!.positions).toBeNull();
  });

  it('one failing account does not hide the other', async () => {
    const { r } = reader({ get: vi.fn(async (key: string) => (key === 'K-SUB' ? { ok: false, status: 502, body: null, errorText: 'timeout' } : okBody('C-MAIN'))) });
    const [a, b] = await r.read('u');
    expect(a!.health).toBe('connected');
    expect(b).toMatchObject({ health: 'stale', positions: null });
  });

  it('remembers the last good read through a failure', async () => {
    let up = true;
    const { r, advance } = reader({ accounts: async () => [main], get: vi.fn(async () => (up ? okBody('C') : { ok: false, status: 502, body: null, errorText: 'down' })) });
    const first = (await r.read('u'))[0]!;
    up = false;
    advance(5_000);
    expect((await r.read('u'))[0]).toMatchObject({ health: 'stale', lastOkAt: first.serverTs });
  });

  it('shares one exchange read between sockets', async () => {
    const { r, deps, advance } = reader({ accounts: async () => [main] });
    await Promise.all([r.read('u'), r.read('u')]);
    expect(deps.get).toHaveBeenCalledTimes(1);
    advance(2_000);
    await r.read('u');
    expect(deps.get).toHaveBeenCalledTimes(2);
  });

  it('writes key health to the database only when it changes', async () => {
    const { r, deps, advance } = reader({ accounts: async () => [main] });
    await r.read('u');
    advance(2_000);
    await r.read('u');
    expect(deps.note).toHaveBeenCalledTimes(1);
  });
});

describe('classifyDeltaFailure', () => {
  it('names each failure', () => {
    expect(classifyDeltaFailure(403, 'ip_not_whitelisted_for_api_key')).toBe('ip_not_whitelisted');
    expect(classifyDeltaFailure(429, '429')).toBe('rate_limited');
    expect(classifyDeltaFailure(401, 'SignatureExpired')).toBe('auth_failed');
    expect(classifyDeltaFailure(502, 'timeout')).toBe('stale');
  });
});
