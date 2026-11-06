import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8');

function fnSource(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`closing brace for ${name} not found`);
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

describe('Key Health panel', () => {
  const source = fnSource('dkHealth');
  const esc = (x: unknown) => String(x).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const render = (health: unknown) => new Function('DK', 'esc', `${source}\nreturn dkHealth();`)({ health }, esc) as string;
  const row = { serverTs: 100_000, lastOkAt: 87_000, error: null, keyLast4: 'a4f2' };

  it('shows nothing until the server has answered', () => {
    expect(render(null)).toBe('');
  });

  it('shows each account by icon and words, with the real age', () => {
    const out = render([{ ...row, account: 'main', health: 'connected' }, { ...row, account: 'sub', health: 'ip_not_whitelisted', error: 'ip_not_whitelisted_for_api_key' }]);
    expect(out).toContain('Main account (read-only key)');
    expect(out).toContain('✓ Connected');
    expect(out).toContain('✕ Server IP not whitelisted on Delta');
    expect(out).toContain('last good read 13s ago');
    expect(out).toContain('key …a4f2');
  });

  it('says so when a key has never worked', () => {
    expect(render([{ ...row, account: 'account', health: 'auth_failed', lastOkAt: null }])).toContain('no successful read yet');
  });

  it("escapes Delta's error text", () => {
    expect(render([{ ...row, account: 'sub', health: 'stale', error: '<img src=x>' }])).not.toContain('<img');
  });
});

describe('page wiring', () => {
  it('has one writer for positions', () => {
    expect(html).not.toContain('pollDeltaPositions');
    expect(html).not.toContain('S.apiPositions =');
  });
});
