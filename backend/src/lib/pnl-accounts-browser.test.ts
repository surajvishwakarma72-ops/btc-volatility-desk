import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8');

function fnSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  return html.slice(start, html.indexOf('\r\n  }\r\n', start) + 5);
}

const load = (S: Record<string, any>) => new Function('S', `${fnSource('applyAccounts')}\n${fnSource('accountWarning')}\nreturn { applyAccounts, accountWarning };`)(S) as { applyAccounts(l: unknown[]): void; accountWarning(m: string): string };
const pos = (symbol: string, size = -5) => ({ product_symbol: symbol, size });
const acct = (account: string, positions: unknown[] | null, health = 'connected', over = {}) => ({ account, positions, health, serverTs: 60_000, lastOkAt: 47_000, ...over });

describe('browser account state', () => {
  it('keeps main and sub in their own slots', () => {
    const S: Record<string, any> = {};
    load(S).applyAccounts([acct('main', [pos('C-MAIN')]), acct('sub', [pos('C-SUB')])]);
    expect(S.deltaPositionsReadOnly.map((p: any) => p.product_symbol)).toEqual(['C-MAIN']);
    expect(S.deltaPositionsReadTrade.map((p: any) => p.product_symbol)).toEqual(['C-SUB']);
  });

  it('drops closed positions', () => {
    const S: Record<string, any> = {};
    load(S).applyAccounts([acct('main', [pos('C-A', 0), pos('C-B')]), acct('sub', [])]);
    expect(S.deltaPositionsReadOnly).toHaveLength(1);
    expect(S.deltaPositionsReadTrade).toHaveLength(0);
  });

  it('keeps the last good positions through a failed read', () => {
    const S: Record<string, any> = { deltaPositionsReadOnly: [pos('C-OLD')] };
    load(S).applyAccounts([acct('main', null, 'stale')]);
    expect(S.deltaPositionsReadOnly[0].product_symbol).toBe('C-OLD');
  });

  it('shows a single account under both tabs, as one list', () => {
    const S: Record<string, any> = {};
    load(S).applyAccounts([acct('account', [pos('C-ONE')])]);
    expect(S.deltaPositionsReadOnly).toBe(S.deltaPositionsReadTrade);
  });

  it('clears an account whose key was removed', () => {
    const S: Record<string, any> = { deltaPositionsReadOnly: [pos('C-A')], deltaPositionsReadTrade: [pos('C-B')] };
    load(S).applyAccounts([]);
    expect(S.deltaPositionsReadOnly).toBeNull();
    expect(S.deltaPositionsReadTrade).toBeNull();
  });

  it('warns about the account on screen only, with the real age', () => {
    const S: Record<string, any> = { accounts: [acct('main', [], 'connected'), acct('sub', null, 'ip_not_whitelisted')] };
    const { accountWarning } = load(S);
    expect(accountWarning('readonly')).toBe('');
    expect(accountWarning('readtrade')).toBe('⚠ server IP not whitelisted on Delta, last update 13s ago');
  });
});

describe('page wiring', () => {
  it('has one writer for positions', () => {
    expect(html).not.toContain('pollDeltaPositions');
    expect(html).not.toContain('S.apiPositions =');
  });
});
