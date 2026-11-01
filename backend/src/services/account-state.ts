import { deltaSignedGet } from '../routes/delta.js';
import { watchedAccounts, type AccountId, type DeskAccount } from './accounts.js';
import { noteDeltaResult, type KeyKind } from './delta-keys.js';

/**
 * The live state of each of a user's Delta accounts, kept apart and labelled. The server reads it; the browser only displays it.
 * A failed read is reported as a failure with `positions: null`. It must never look like an empty account.
 */
export type AccountHealth = 'connected' | 'auth_failed' | 'ip_not_whitelisted' | 'rate_limited' | 'stale';

export interface AccountState {
  account: AccountId;
  kind: KeyKind;
  health: AccountHealth;
  /** Delta's own reason, when the read failed. */
  error: string | null;
  /** Null when this read failed: nothing is known, which is not the same as flat. */
  positions: unknown[] | null;
  /** When the server last read this account successfully. */
  lastOkAt: number | null;
  /** When the server made this report. */
  serverTs: number;
}

export function classifyDeltaFailure(status: number, errorText: string): AccountHealth {
  if (/whitelist/i.test(errorText)) return 'ip_not_whitelisted';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403 || /api.?key|signature|unauthori[sz]ed/i.test(errorText)) return 'auth_failed';
  return 'stale';
}

type SignedGet = (key: string, secret: string, path: string, query: string) => Promise<{ ok: boolean; status: number; body: unknown; errorText: string }>;

export interface AccountReaderDeps {
  accounts(userId: string): Promise<DeskAccount[]>;
  get: SignedGet;
  note(userId: string, ok: boolean, error: string | null, kind: KeyKind): Promise<void>;
  now(): number;
}

const CACHE_MS = 1_500;

export class AccountReader {
  private cache = new Map<string, { at: number; result: Promise<AccountState[]> }>();
  private lastOk = new Map<string, number>();
  private lastHealth = new Map<string, AccountHealth>();

  constructor(private deps: AccountReaderDeps) {}

  /** Every socket of a user shares one read, so extra open tabs cost no extra exchange calls. */
  read(userId: string): Promise<AccountState[]> {
    const hit = this.cache.get(userId);
    if (hit && this.deps.now() - hit.at < CACHE_MS) return hit.result;
    const result = this.fetchAll(userId);
    this.cache.set(userId, { at: this.deps.now(), result });
    result.catch(() => this.cache.delete(userId));
    return result;
  }

  private async fetchAll(userId: string): Promise<AccountState[]> {
    const accounts = await this.deps.accounts(userId);
    return Promise.all(accounts.map((a) => this.fetchOne(userId, a)));
  }

  private async fetchOne(userId: string, a: DeskAccount): Promise<AccountState> {
    const r = await this.deps.get(a.creds.key, a.creds.secret, '/v2/positions/margined', 'contract_types=call_options,put_options');
    const id = `${userId}|${a.account}`;
    const serverTs = this.deps.now();
    const body = r.body as { result?: unknown[] | { positions?: unknown[] } } | null;
    const list = !r.ok ? null : Array.isArray(body?.result) ? body.result : Array.isArray(body?.result?.positions) ? body.result.positions : null;
    const health: AccountHealth = list ? 'connected' : classifyDeltaFailure(r.status, r.errorText);
    if (list) this.lastOk.set(id, serverTs);
    const error = list ? null : r.errorText || `HTTP ${r.status}`;
    if (this.lastHealth.get(id) !== health) {
      this.lastHealth.set(id, health);
      void this.deps.note(userId, !!list, error, a.kind);
    }
    return { account: a.account, kind: a.kind, health, error, positions: list, lastOkAt: this.lastOk.get(id) ?? null, serverTs };
  }
}

export const accountReader = new AccountReader({
  accounts: watchedAccounts,
  get: (key, secret, path, query) => deltaSignedGet(key, secret, path, query),
  note: noteDeltaResult,
  now: () => Date.now(),
});
