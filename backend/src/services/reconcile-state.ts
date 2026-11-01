/** Latest check of an account's positions against its fills. Kept in memory: it is redone every sync. */
export interface ReconcileStatus {
  state: 'ok' | 'mismatch';
  symbols: string[];
  checkedAt: number;
}

const status = new Map<string, ReconcileStatus>();
const key = (userId: string, account: string): string => `${userId}|${account}`;

export const reconcileStatus = (userId: string, account: string): ReconcileStatus | null => status.get(key(userId, account)) ?? null;
export const setReconcileStatus = (userId: string, account: string, s: ReconcileStatus): void => { status.set(key(userId, account), s); };
export const clearReconcileStatus = (): void => status.clear();
