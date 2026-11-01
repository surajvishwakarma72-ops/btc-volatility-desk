import { DESK_USER_ID } from './auth-store.js';
import { loadDeltaKey, type KeyKind } from './delta-keys.js';

/** Which Delta accounts a user has. Main and sub are told apart by holding two different keys; a single key is just 'account'. */
export type AccountId = 'main' | 'sub' | 'account';

export interface DeskAccount {
  account: AccountId;
  /** The saved key this account uses. */
  kind: KeyKind;
  creds: { key: string; secret: string };
  /** Legs on this account are watched but never acted on. */
  watchOnly: boolean;
}

async function readCreds(userId: string): Promise<{ key: string; secret: string } | null> {
  const own = await loadDeltaKey(userId, 'read');
  if (own) return own;
  // the owner may still rely on the server's own key until a personal one is saved
  if (userId === DESK_USER_ID && process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET) return { key: process.env.DELTA_API_KEY, secret: process.env.DELTA_API_SECRET };
  return null;
}

/**
 * The accounts to watch: the read key's account and, when the trading key belongs to a different account (a sub-account), that one too.
 * Legs from the read account are watch-only when the two differ, because the hard exit only ever sends orders with the trading key.
 */
export async function watchedAccounts(userId: string): Promise<DeskAccount[]> {
  const read = await readCreds(userId);
  const trade = await loadDeltaKey(userId, 'trade');
  if (read && trade && read.key !== trade.key) {
    return [{ account: 'main', kind: 'read', creds: read, watchOnly: true }, { account: 'sub', kind: 'trade', creds: trade, watchOnly: false }];
  }
  if (trade) return [{ account: 'account', kind: 'trade', creds: trade, watchOnly: false }];
  return read ? [{ account: 'account', kind: 'read', creds: read, watchOnly: false }] : [];
}
