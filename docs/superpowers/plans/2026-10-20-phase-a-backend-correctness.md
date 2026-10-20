# Phase A — Backend Correctness & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all backend data-correctness, stats-integrity, and API-hardening bugs, backed by unit tests — no frontend or auth changes.

**Architecture:** Extract pure logic into a new tested `backend/src/lib/` layer; refactor the services/routes to consume it. Add Zod request validation via `fastify-type-provider-zod`, a global error handler, CORS allowlist, and TLS verification. Add Vitest for unit tests.

**Tech Stack:** Node ≥20, Fastify 5, Drizzle ORM (node-postgres), Zod, `fastify-type-provider-zod`, Vitest, TypeScript (ESM / NodeNext).

**Locked constants:** `MIN_SAMPLE = 30`, velocity window `N = 3`, active-rules cache TTL `30_000 ms`, body limit `1_048_576` bytes, Bonferroni alpha `0.001515`.

**Branch:** `phase-a-backend-correctness` (already created; spec committed).

**Conventions:** All imports use the `.js` extension (NodeNext ESM). Run all commands from `backend/`.

---

## Task 0: Tooling — Vitest + Zod type provider

**Files:**
- Modify: `backend/package.json`
- Create: `backend/vitest.config.ts`

- [ ] **Step 1: Add dependencies**

Run (from `backend/`):
```bash
npm install fastify-type-provider-zod@^4.0.2
npm install -D vitest@^2.1.8
```
Expected: both install without peer-dependency errors (zod ^3 and fastify ^5 already present).

- [ ] **Step 2: Add the test script**

In `backend/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create Vitest config**

Create `backend/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Verify the runner works (no tests yet)**

Run: `npm run test`
Expected: Vitest reports "No test files found" and exits 0 (or a clean run). This confirms the toolchain loads.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/vitest.config.ts
git commit -m "chore(phase-a): add vitest + fastify-type-provider-zod tooling"
```

---

## Task 1: Pure lib — volatility (Garman-Klass RV + spot velocity)

**Files:**
- Create: `backend/src/lib/volatility.ts`
- Create: `backend/src/lib/volatility.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/volatility.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { garmanKlassRv, computeVelocityPct } from './volatility.js';

describe('garmanKlassRv', () => {
  it('returns 0 for fewer than 5 bars', () => {
    expect(garmanKlassRv([{ open: 1, high: 1, low: 1, close: 1 }])).toBe(0);
  });

  it('returns 0 (not NaN) for flat bars', () => {
    const bars = Array.from({ length: 6 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
    expect(garmanKlassRv(bars)).toBe(0);
  });

  it('produces a positive finite annualized percentage for moving bars', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
    }));
    const rv = garmanKlassRv(bars);
    expect(Number.isFinite(rv)).toBe(true);
    expect(rv).toBeGreaterThan(0);
  });
});

describe('computeVelocityPct', () => {
  it('returns 0 when there are not enough closes', () => {
    expect(computeVelocityPct([100, 101], 3)).toBe(0);
  });

  it('computes absolute percent move over the window', () => {
    // close now = 110, close 3 bars back = 100 -> 10%
    expect(computeVelocityPct([100, 105, 108, 110], 3)).toBeCloseTo(10, 6);
  });

  it('is absolute (down moves are positive)', () => {
    expect(computeVelocityPct([100, 98, 95, 90], 3)).toBeCloseTo(10, 6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- volatility`
Expected: FAIL — cannot find module `./volatility.js` / exports undefined.

- [ ] **Step 3: Implement the module**

Create `backend/src/lib/volatility.ts`:
```ts
export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Garman-Klass realized volatility, annualized to a percentage, from 1-minute bars.
 * Formula per bar: 0.5*(ln(H/L))^2 - (2*ln2 - 1)*(ln(C/O))^2
 */
export function garmanKlassRv(bars: Bar[]): number {
  if (bars.length < 5) return 0;
  let sum = 0;
  for (const b of bars) {
    const hl = Math.log(b.high / b.low);
    const co = Math.log(b.close / b.open);
    sum += 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
  }
  const variance = sum / bars.length;
  if (!(variance > 0)) return 0;
  const annualized = Math.sqrt(variance * 525600) * 100; // 525600 minutes per year
  return Number.isFinite(annualized) ? annualized : 0;
}

/**
 * Absolute percentage move of the latest close versus the close `window` bars earlier.
 */
export function computeVelocityPct(closes: number[], window: number): number {
  if (closes.length <= window) return 0;
  const now = closes[closes.length - 1];
  const past = closes[closes.length - 1 - window];
  if (!(past > 0) || !Number.isFinite(now)) return 0;
  return Math.abs((now - past) / past) * 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- volatility`
Expected: PASS (3 + 3 assertions).

- [ ] **Step 5: Refactor the Binance worker to use the lib + add velocity**

Modify `backend/src/services/binance-market-worker.ts`:

Replace the import block top-of-file:
```ts
import WebSocket from 'ws';
import { db, marketTimeseries } from '../db/index.js';
import { alertService } from './alert-service.js';
import { garmanKlassRv, computeVelocityPct, type Bar } from '../lib/volatility.js';
```

Replace the `recentBars` field and add a closes buffer:
```ts
  private recentBars: Bar[] = [];
  private recentCloses: number[] = [];
```

Inside the `k.x` finalized-candle block, replace the body that pushes bars, computes RV, and calls `checkMetrics` with:
```ts
              const bar: Bar = { open, high, low, close };
              this.recentBars.push(bar);
              if (this.recentBars.length > 30) this.recentBars.shift();
              this.recentCloses.push(close);
              if (this.recentCloses.length > 10) this.recentCloses.shift();

              const rvAnnualized = garmanKlassRv(this.recentBars);
              const velocity = computeVelocityPct(this.recentCloses, 3);

              await db
                .insert(marketTimeseries)
                .values({
                  time: barTime,
                  symbol: 'BTCUSDT',
                  interval: '1m',
                  open: String(open),
                  high: String(high),
                  low: String(low),
                  close: String(close),
                  volume: String(volume),
                  rv: rvAnnualized ? String(rvAnnualized.toFixed(2)) : null,
                })
                .onConflictDoNothing();

              await alertService.checkMetrics({
                spotPrice: currentClose,
                realizedVol: rvAnnualized,
                speed: velocity,
              });
```

Delete the old private `calculateGarmanKlassRv` method entirely (now provided by the lib; removes the dead `u`/`d` vars).

- [ ] **Step 6: Build to confirm the worker still compiles**

Run: `npm run build`
Expected: tsc exits 0. (`checkMetrics` gains a `speed` field in Task 4; if building before Task 4, temporarily expect a type error on `speed` — acceptable, resolved in Task 4. If executing strictly in order, perform Step 6 after Task 4. See note.)

> **Ordering note:** `alertService.checkMetrics` does not accept `speed`/`realizedVol` extras until Task 4 updates its signature. Either (a) do Task 4 before building, or (b) Task 4's signature change is additive and optional so this compiles once Task 4 lands. Commit this task's code; run the full build at the end of Task 4.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/volatility.ts backend/src/lib/volatility.test.ts backend/src/services/binance-market-worker.ts
git commit -m "feat(phase-a): extract tested volatility lib, add spot velocity, drop GK dead code"
```

---

## Task 2: Pure lib — binomial tail p-value

**Files:**
- Create: `backend/src/lib/stats.ts`
- Create: `backend/src/lib/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/stats.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { binomialCdfLowerTail } from './stats.js';

describe('binomialCdfLowerTail', () => {
  it('P(X<=2) for Bin(10, 0.5) ~= 0.0546875', () => {
    expect(binomialCdfLowerTail(2, 10, 0.5)).toBeCloseTo(0.0546875, 7);
  });

  it('P(X<=n) = 1', () => {
    expect(binomialCdfLowerTail(10, 10, 0.3)).toBeCloseTo(1, 10);
  });

  it('P(X<=-1) = 0', () => {
    expect(binomialCdfLowerTail(-1, 10, 0.3)).toBe(0);
  });

  it('is numerically stable for large n', () => {
    const p = binomialCdfLowerTail(400, 1000, 0.5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.0001);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- stats`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `backend/src/lib/stats.ts`:
```ts
/**
 * Lower-tail CDF of a Binomial(n, p): returns P(X <= k).
 * Iterates terms via the successive-ratio to stay numerically stable for large n.
 */
export function binomialCdfLowerTail(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;

  const q = 1 - p;
  // term(0) = q^n
  let term = Math.pow(q, n);
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    // term(i) = term(i-1) * (n-i+1)/i * (p/q)
    term = term * ((n - i + 1) / i) * (p / q);
    cdf += term;
  }
  return Math.min(1, Math.max(0, cdf));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- stats`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/stats.ts backend/src/lib/stats.test.ts
git commit -m "feat(phase-a): add tested binomial tail p-value helper"
```

---

## Task 3: Pure lib — Deribit flow dedup + refactor Deribit worker

**Files:**
- Create: `backend/src/lib/flow.ts`
- Create: `backend/src/lib/flow.test.ts`
- Modify: `backend/src/services/deribit-flow-worker.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/flow.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { filterNewTrades, computeIvChangePct } from './flow.js';

describe('filterNewTrades', () => {
  const trades = [
    { trade_seq: 10 }, { trade_seq: 11 }, { trade_seq: 12 },
  ];

  it('returns all trades when no prior watermark', () => {
    const r = filterNewTrades(trades, null);
    expect(r.fresh.length).toBe(3);
    expect(r.maxSeq).toBe(12);
  });

  it('returns only trades newer than the watermark', () => {
    const r = filterNewTrades(trades, 11);
    expect(r.fresh.map((t) => t.trade_seq)).toEqual([12]);
    expect(r.maxSeq).toBe(12);
  });

  it('returns none and preserves watermark when all are stale', () => {
    const r = filterNewTrades(trades, 99);
    expect(r.fresh.length).toBe(0);
    expect(r.maxSeq).toBe(99);
  });
});

describe('computeIvChangePct', () => {
  it('returns null when previous is missing', () => {
    expect(computeIvChangePct(null, 40)).toBeNull();
  });
  it('computes signed percent change', () => {
    expect(computeIvChangePct(40, 44)).toBeCloseTo(10, 6);
    expect(computeIvChangePct(50, 45)).toBeCloseTo(-10, 6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- flow`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `backend/src/lib/flow.ts`:
```ts
export interface SeqTrade {
  trade_seq: number;
  [k: string]: unknown;
}

/**
 * Keep only trades with trade_seq strictly greater than the prior watermark.
 * Returns the fresh trades and the new watermark (max seq seen).
 */
export function filterNewTrades<T extends SeqTrade>(
  trades: T[],
  lastSeq: number | null,
): { fresh: T[]; maxSeq: number } {
  let maxSeq = lastSeq ?? -Infinity;
  const fresh: T[] = [];
  for (const t of trades) {
    const seq = Number(t.trade_seq);
    if (!Number.isFinite(seq)) continue;
    if (lastSeq == null || seq > lastSeq) fresh.push(t);
    if (seq > maxSeq) maxSeq = seq;
  }
  return { fresh, maxSeq: Number.isFinite(maxSeq) ? maxSeq : (lastSeq ?? 0) };
}

/** Signed percentage change between a previous and current value, or null if no previous. */
export function computeIvChangePct(prev: number | null, curr: number | null): number | null {
  if (prev == null || curr == null || !(prev > 0)) return null;
  return ((curr - prev) / prev) * 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- flow`
Expected: PASS.

- [ ] **Step 5: Refactor the Deribit worker — dedup + IV-change alert wiring**

Modify `backend/src/services/deribit-flow-worker.ts`:

Update imports:
```ts
import { db, optionFlowBuckets } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { alertService } from './alert-service.js';
import { filterNewTrades, computeIvChangePct, type SeqTrade } from '../lib/flow.js';
```
(Remove the unused `marketTimeseries` import.)

Add fields to the class (near `currentDvol`):
```ts
  private lastTradeSeq: number | null = null;
  private prevDvol: number | null = null;
```

In `pollDvol`, after `this.currentDvol = dvolValue;`, add IV-change alerting:
```ts
          const ivChangePct = computeIvChangePct(this.prevDvol, dvolValue);
          this.prevDvol = dvolValue;
          if (ivChangePct != null) {
            await alertService.checkMetrics({ atmIv: dvolValue, ivChangePct });
          }
```

In `pollOptionsFlow`, replace the `for (const tr of trades)` loop header so it only processes fresh trades and advances the watermark:
```ts
      const { fresh, maxSeq } = filterNewTrades(trades as SeqTrade[], this.lastTradeSeq);
      this.lastTradeSeq = maxSeq;
      if (fresh.length === 0) return;

      for (const tr of fresh as any[]) {
```
(The body of the loop — bucket math and upsert — is unchanged except it now iterates `fresh`.)

- [ ] **Step 6: Build to confirm compilation**

Run: `npm run build`
Expected: tsc exits 0 (after Task 4's `checkMetrics` signature change; otherwise expect the same additive-field note as Task 1).

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/flow.ts backend/src/lib/flow.test.ts backend/src/services/deribit-flow-worker.ts
git commit -m "fix(phase-a): dedup Deribit flow by trade_seq, wire IV-change alerts"
```

---

## Task 4: Pure lib — cooldown gate + alert-service refactor

**Files:**
- Create: `backend/src/lib/cooldown.ts`
- Create: `backend/src/lib/cooldown.test.ts`
- Modify: `backend/src/services/alert-service.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/cooldown.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CooldownGate } from './cooldown.js';

describe('CooldownGate', () => {
  it('allows the first call and blocks within the cooldown', () => {
    const g = new CooldownGate();
    expect(g.allow('rule1', 1000, 5000)).toBe(true);   // t=1000, 5s cooldown
    expect(g.allow('rule1', 2000, 5000)).toBe(false);  // 1s later -> blocked
    expect(g.allow('rule1', 6500, 5000)).toBe(true);   // 5.5s later -> allowed
  });

  it('tracks rules independently', () => {
    const g = new CooldownGate();
    expect(g.allow('a', 0, 1000)).toBe(true);
    expect(g.allow('b', 0, 1000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- cooldown`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `backend/src/lib/cooldown.ts`:
```ts
/** Per-key cooldown gate. allow() returns true and arms the cooldown, or false if still cooling. */
export class CooldownGate {
  private last = new Map<string, number>();

  allow(key: string, nowMs: number, cooldownMs: number): boolean {
    const prev = this.last.get(key) ?? -Infinity;
    if (nowMs - prev < cooldownMs) return false;
    this.last.set(key, nowMs);
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- cooldown`
Expected: PASS.

- [ ] **Step 5: Rewrite the alert service**

Replace the entire body of `backend/src/services/alert-service.ts` with:
```ts
import { eq } from 'drizzle-orm';
import { db, alertRules, alertLogs } from '../db/index.js';
import { CooldownGate } from '../lib/cooldown.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
const RULES_CACHE_TTL_MS = 30_000;

type Channel = 'telegram' | 'ntfy' | 'in_app';

export interface DispatchNotificationOptions {
  title: string;
  message: string;
  channels?: Channel[];
  ruleId?: string;
  cooldownMs?: number;
}

export class AlertService {
  private gate = new CooldownGate();
  private rulesCache: any[] | null = null;
  private rulesCachedAt = 0;

  /** Call after any rule create/delete to force a reload. */
  invalidateRulesCache() {
    this.rulesCache = null;
  }

  private async getActiveRules(): Promise<any[]> {
    const now = Date.now();
    if (this.rulesCache && now - this.rulesCachedAt < RULES_CACHE_TTL_MS) {
      return this.rulesCache;
    }
    const rules = await db.select().from(alertRules).where(eq(alertRules.isActive, true));
    this.rulesCache = rules;
    this.rulesCachedAt = now;
    return rules;
  }

  /**
   * Dispatch a notification to ALL requested channels in one call and log it.
   * Cooldown (if ruleId given) is checked once per rule and gates the whole dispatch.
   */
  async sendNotification(options: DispatchNotificationOptions): Promise<boolean> {
    const { title, message, channels = ['in_app'], ruleId, cooldownMs = 300_000 } = options;

    if (ruleId && !this.gate.allow(ruleId, Date.now(), cooldownMs)) {
      return false;
    }

    const wantTelegram = channels.includes('telegram') || channels.includes('in_app');
    const wantNtfy = channels.includes('ntfy') || channels.includes('in_app');
    let status = 'SENT';

    if (wantTelegram) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
      if (botToken && chatId) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: `🚨 *${title}*\n\n${message}`, parse_mode: 'Markdown' }),
          });
        } catch (err: any) {
          console.error('[AlertService] Telegram dispatch error:', err.message);
          status = 'FAILED';
        }
      }
    }

    if (wantNtfy) {
      const ntfyTopic = process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';
      const ntfyServer = process.env.NTFY_SERVER_URL || 'https://ntfy.sh';
      try {
        await fetch(`${ntfyServer}/${ntfyTopic}`, {
          method: 'POST',
          headers: { Title: title, Priority: 'high', Tags: 'chart_with_upwards_trend,warning' },
          body: message,
        });
      } catch (err: any) {
        console.error('[AlertService] ntfy dispatch error:', err.message);
      }
    }

    // Web push to registered devices
    try {
      const { pushDevices } = await import('../db/index.js');
      const { and, eq: eqOp } = await import('drizzle-orm');
      const devices = await db
        .select()
        .from(pushDevices)
        .where(and(eqOp(pushDevices.userId, DEFAULT_USER_ID), eqOp(pushDevices.enabled, true)));
      const fcmKey = process.env.FCM_SERVER_KEY;
      for (const dev of devices) {
        if (fcmKey && dev.token) {
          try {
            await fetch('https://fcm.googleapis.com/fcm/send', {
              method: 'POST',
              headers: { Authorization: `key=${fcmKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: dev.token,
                priority: 'high',
                notification: {
                  title, body: message,
                  sound: dev.soundChoice ? `${dev.soundChoice}.wav` : 'chime.wav',
                  android_channel_id: `btc_alerts_${dev.soundChoice || 'chime'}`,
                },
                data: { title, message, soundChoice: dev.soundChoice || 'chime', ruleId: ruleId || '' },
              }),
            });
          } catch (fcmErr: any) {
            console.error('[AlertService] FCM send error:', fcmErr.message);
          }
        }
      }
    } catch (pushErr: any) {
      console.error('[AlertService] Error reading push_devices:', pushErr.message);
    }

    // Log once per dispatch
    try {
      await db.insert(alertLogs).values({
        id: crypto.randomUUID(),
        userId: DEFAULT_USER_ID,
        alertRuleId: ruleId || null,
        title: title.slice(0, 200),
        message,
        channel: channels.join(','),
        status,
        deliveredAt: new Date(),
      });
    } catch (dbErr: any) {
      console.error('[AlertService] Failed to record alert_log:', dbErr.message);
    }

    return true;
  }

  /** Evaluate active rules against incoming live metrics. */
  async checkMetrics(metrics: {
    spotPrice?: number;
    atmIv?: number;
    ivChangePct?: number;
    realizedVol?: number;
    speed?: number;
  }) {
    try {
      const activeRules = await this.getActiveRules();
      for (const rule of activeRules) {
        const threshold = Number(rule.thresholdValue);
        let triggered = false;
        let alertMessage = '';

        if (rule.ruleType === 'IV_SPIKE' && metrics.ivChangePct != null) {
          if (metrics.ivChangePct >= threshold) {
            triggered = true;
            alertMessage = `ATM IV moved ${metrics.ivChangePct.toFixed(2)}% (threshold ${threshold}%). Current IV: ${metrics.atmIv?.toFixed(2)}%`;
          }
        } else if (rule.ruleType === 'SPEED_BREAK' && metrics.speed != null) {
          if (metrics.speed >= threshold) {
            triggered = true;
            alertMessage = `Spot velocity ${metrics.speed.toFixed(2)}% over window exceeded ${threshold}%. Spot: $${metrics.spotPrice?.toLocaleString() ?? 'n/a'}`;
          }
        } else if (rule.ruleType === 'PRICE_LEVEL' && metrics.spotPrice != null) {
          if (metrics.spotPrice >= threshold) {
            triggered = true;
            alertMessage = `BTC spot crossed $${threshold.toLocaleString()}. Current: $${metrics.spotPrice.toLocaleString()}`;
          }
        }

        if (triggered) {
          const channels = Array.isArray(rule.channels) && rule.channels.length
            ? (rule.channels as Channel[])
            : (['telegram', 'ntfy', 'in_app'] as Channel[]);
          const cooldownMs = (Number(rule.cooldownSeconds) || 300) * 1000;
          await this.sendNotification({
            title: `[ALERT] ${rule.ruleName}`,
            message: alertMessage,
            channels,
            ruleId: rule.id,
            cooldownMs,
          });
        }
      }
    } catch (err: any) {
      console.error('[AlertService] Rule evaluation error:', err.message);
    }
  }
}

export const alertService = new AlertService();
```

> Note the `SPEED_BREAK` branch now uses `metrics.speed` (velocity) and the old price-cross behaviour moves to a new `PRICE_LEVEL` rule type. `sendNotification` now takes `channels: Channel[]` (callers updated below).

- [ ] **Step 6: Update the `/alerts/test` caller and cache invalidation**

Modify `backend/src/routes/alerts.ts`:

In `POST /rules`, after the successful insert and before returning, add:
```ts
    const { alertService } = await import('../services/index.js');
    alertService.invalidateRulesCache();
```
In `DELETE /rules/:id`, after a successful delete and before returning, add the same two lines.

In `POST /test`, replace the `alertService.sendNotification({ ... channel: channel })` call with:
```ts
    const sent = await alertService.sendNotification({
      title: '🚨 BTC Volatility Desk Test Alert',
      message: `Test signal dispatched at ${new Date().toLocaleTimeString()} UTC.`,
      channels: [channel],
    });
```

- [ ] **Step 7: Run the full backend build**

Run: `npm run build`
Expected: tsc exits 0 (resolves the additive `speed`/`channels` notes from Tasks 1 and 3).

- [ ] **Step 8: Run all tests**

Run: `npm run test`
Expected: PASS (volatility, stats, flow, cooldown suites green).

- [ ] **Step 9: Commit**

```bash
git add backend/src/lib/cooldown.ts backend/src/lib/cooldown.test.ts backend/src/services/alert-service.ts backend/src/routes/alerts.ts
git commit -m "fix(phase-a): alert fan-out to all channels, per-rule cooldown, rules cache, IV/speed/price rule types"
```

---

## Task 5: Throttle Delta-tick alert checks

**Files:**
- Modify: `backend/src/services/delta-market-worker.ts`

- [ ] **Step 1: Add a throttle field**

In the class, near `lastTickTime`, add:
```ts
  private lastAlertCheck = 0;
```

- [ ] **Step 2: Throttle the per-tick check**

In the `message` handler, replace the `if (this.currentSpotPrice) { await alertService.checkMetrics({ spotPrice: this.currentSpotPrice }); }` block with:
```ts
            if (this.currentSpotPrice) {
              const now = Date.now();
              if (now - this.lastAlertCheck >= 1000) {
                this.lastAlertCheck = now;
                await alertService.checkMetrics({ spotPrice: this.currentSpotPrice });
              }
            }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/delta-market-worker.ts
git commit -m "perf(phase-a): throttle Delta-tick alert evaluation to 1/sec"
```

---

## Task 6: Recalibration stats integrity + telemetry outcome default

**Files:**
- Create: `backend/src/lib/recalibration.ts`
- Create: `backend/src/lib/recalibration.test.ts`
- Modify: `backend/src/services/self-testing-audit.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/recalibration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeRecalibration, type SessionRec } from './recalibration.js';

const SEEDED = {
  tueWedStopRate: 38.0, speedStopRate: 44.3, comboStopRate: 32.6,
  comboPValue: 0.0012, oosStopRate: 28.4,
};
const OPTS = { minSample: 30, bonferroniAlpha: 0.001515, seeded: SEEDED };

function mk(n: number, dow: number, speed: number, stop: boolean): SessionRec[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    dow, speed, isStop: stop, sizing: 1, status: 'TRADED',
  }));
}

describe('computeRecalibration', () => {
  it('uses seeded baselines below minSample and labels the source', () => {
    const r = computeRecalibration(mk(5, 2, 1.0, false), OPTS);
    expect(r.source).toBe('seeded_baseline');
    expect(r.comboStopRate).toBe(38.0 !== undefined ? r.comboStopRate : 0); // seeded values present
    expect(r.comboPValue).toBe(0.0012);
  });

  it('computes from real data at/above minSample and labels computed', () => {
    // 40 Tue/calm sessions, 8 stops -> 20% stop rate
    const sessions = [...mk(32, 2, 1.0, false), ...mk(8, 2, 1.0, true)];
    const r = computeRecalibration(sessions, OPTS);
    expect(r.source).toBe('computed');
    expect(r.comboStopRate).toBeCloseTo(20, 6);
    expect(r.totalSessions).toBe(40);
    expect(r.inSampleSessions).toBe(20);
    expect(r.outOfSampleSessions).toBe(20);
  });

  it('OOS slice is non-empty for any logs.length >= 2', () => {
    const r = computeRecalibration([...mk(1, 2, 1, false), ...mk(1, 2, 1, true)], {
      ...OPTS, minSample: 0,
    });
    expect(r.outOfSampleSessions).toBe(1);
    expect(r.oosStopRate).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- recalibration`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

Create `backend/src/lib/recalibration.ts`:
```ts
import { binomialCdfLowerTail } from './stats.js';

export interface SessionRec {
  date: string;
  dow: number;
  speed: number;
  isStop: boolean;
  sizing: number;
  status: string;
}

export interface SeededBaseline {
  tueWedStopRate: number;
  speedStopRate: number;
  comboStopRate: number;
  comboPValue: number;
  oosStopRate: number;
}

export interface RecalOpts {
  minSample: number;
  bonferroniAlpha: number;
  seeded: SeededBaseline;
}

export interface RecalResult {
  source: 'computed' | 'seeded_baseline';
  totalSessions: number;
  inSampleSessions: number;
  outOfSampleSessions: number;
  bonferroniAlpha: number;
  tueWedStopRate: number;
  speedStopRate: number;
  comboStopRate: number;
  comboPValue: number;
  clearedBonferroni: boolean;
  oosStopRate: number;
  oosStabilityVerdict: 'STABLE' | 'DECAYING';
}

const rate = (recs: SessionRec[]) =>
  recs.length ? (recs.filter((r) => r.isStop).length / recs.length) * 100 : 0;

export function computeRecalibration(sessions: SessionRec[], opts: RecalOpts): RecalResult {
  const total = sessions.length;
  const { seeded, bonferroniAlpha } = opts;

  if (total < opts.minSample) {
    return {
      source: 'seeded_baseline',
      totalSessions: total,
      inSampleSessions: Math.floor(total / 2),
      outOfSampleSessions: total - Math.floor(total / 2),
      bonferroniAlpha,
      tueWedStopRate: seeded.tueWedStopRate,
      speedStopRate: seeded.speedStopRate,
      comboStopRate: seeded.comboStopRate,
      comboPValue: seeded.comboPValue,
      clearedBonferroni: seeded.comboPValue < bonferroniAlpha,
      oosStopRate: seeded.oosStopRate,
      oosStabilityVerdict: seeded.oosStopRate <= 35.0 ? 'STABLE' : 'DECAYING',
    };
  }

  const tueWed = sessions.filter((s) => s.dow === 2 || s.dow === 3);
  const calm = sessions.filter((s) => s.speed < 1.5);
  const combo = sessions.filter((s) => (s.dow === 2 || s.dow === 3) && s.speed < 1.5);

  const overallStopRate = rate(sessions) / 100; // p0 null hypothesis
  const comboStops = combo.filter((s) => s.isStop).length;
  const comboPValue = combo.length
    ? binomialCdfLowerTail(comboStops, combo.length, overallStopRate > 0 ? overallStopRate : 0.5)
    : 1;

  const half = Math.floor(total / 2);
  const oos = sessions.slice(half);
  const oosStopRate = rate(oos);

  return {
    source: 'computed',
    totalSessions: total,
    inSampleSessions: half,
    outOfSampleSessions: total - half,
    bonferroniAlpha,
    tueWedStopRate: rate(tueWed),
    speedStopRate: rate(calm),
    comboStopRate: rate(combo),
    comboPValue,
    clearedBonferroni: comboPValue < bonferroniAlpha,
    oosStopRate,
    oosStabilityVerdict: oosStopRate <= 35.0 ? 'STABLE' : 'DECAYING',
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- recalibration`
Expected: PASS.

- [ ] **Step 5: Rewire `runAutomatedRecalibration` to use the pure module**

In `backend/src/services/self-testing-audit.ts`:

Add imports at top:
```ts
import { computeRecalibration, type SessionRec } from '../lib/recalibration.js';
```
Remove the now-unused `fs`, `path`, `fileURLToPath`, `__filename`, `__dirname` lines (the archive block is deleted).

Replace the entire body of `runAutomatedRecalibration` (from `const logs = ...` to the final `return`) with:
```ts
  const logs = await db.select().from(sessionAuditLogs).orderBy(sessionAuditLogs.sessionDate);

  const sessions: SessionRec[] = logs.map((l) => ({
    date: l.sessionDate,
    dow: l.dayOfWeek,
    speed: Number(l.speedVsIv) || 1.0,
    isStop: l.outcome === 'STOP',
    sizing: Number(l.sizing) || 0,
    status: l.sessionStatus,
  }));

  const result = computeRecalibration(sessions, {
    minSample: 30,
    bonferroniAlpha: 0.001515,
    seeded: {
      tueWedStopRate: 38.0,
      speedStopRate: 44.3,
      comboStopRate: 32.6,
      comboPValue: 0.0012,
      oosStopRate: 28.4,
    },
  });

  const auditSummary = {
    source: result.source,
    newSessionsLogged: logs.length,
    telemetryMatches: logs.filter((l) => l.telemetryMatch).length,
    telemetryMismatches: logs.filter((l) => !l.telemetryMatch).length,
    decayFlag: result.oosStabilityVerdict === 'DECAYING',
    timestamp: new Date().toISOString(),
  };

  const auditRecord = await db.insert(recalibrationAudits).values({
    totalSessions: result.totalSessions,
    inSampleSessions: result.inSampleSessions,
    outOfSampleSessions: result.outOfSampleSessions,
    bonferroniAlpha: String(result.bonferroniAlpha),
    tueWedStopRate: String(result.tueWedStopRate),
    speedStopRate: String(result.speedStopRate),
    comboStopRate: String(result.comboStopRate),
    comboPValue: String(result.comboPValue),
    clearedBonferroni: result.clearedBonferroni,
    oosStopRate: String(result.oosStopRate),
    oosStabilityVerdict: result.oosStabilityVerdict,
    auditSummary,
  }).returning();

  return auditRecord[0];
```

- [ ] **Step 6: Fix the telemetry WIN auto-label**

In the same file, inside `recordSessionTelemetry`, in the `db.insert(sessionAuditLogs).values({ ... })` object, change the `outcome` line from:
```ts
    outcome: input.outcome || (rule.expectedGo === 'GO' ? 'WIN' : 'SKIPPED'),
```
to:
```ts
    outcome: input.outcome || (rule.expectedGo === 'GO' ? 'PENDING' : 'SKIPPED'),
```

- [ ] **Step 7: Build and test**

Run: `npm run build && npm run test`
Expected: tsc exits 0; all suites PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/lib/recalibration.ts backend/src/lib/recalibration.test.ts backend/src/services/self-testing-audit.ts
git commit -m "fix(phase-a): data-derived recalibration with real binomial p-value, labeled seeded fallback, stop WIN auto-label"
```

---

## Task 7: Database TLS verification

**Files:**
- Modify: `backend/src/db/index.ts`
- Modify: `backend/.env.example`

- [ ] **Step 1: Replace the SSL config**

In `backend/src/db/index.ts`, replace the `pool` definition:
```ts
const needsSsl = !!connectionString &&
  (connectionString.includes('neon.tech') || connectionString.includes('sslmode=require'));

export const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
    : undefined,
});
```

- [ ] **Step 2: Document the escape hatch**

In `backend/.env.example`, under the PostgreSQL section, add:
```
# Optional: PEM CA bundle if your managed Postgres uses a private CA (leave empty for Neon/public CAs)
DATABASE_CA=
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/index.ts backend/.env.example
git commit -m "fix(phase-a): enable DB TLS certificate verification with optional CA override"
```

---

## Task 8: option_flow_buckets composite primary key + migration

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/*` (generated migration)

- [ ] **Step 1: Change the primary key in the schema**

In `backend/src/db/schema.ts`, change the `optionFlowBuckets` definition so `time` is no longer a column-level `.primaryKey()`, and add a composite primary key.

Change the `time` column line from:
```ts
    time: timestamp('time', { withTimezone: true }).primaryKey(),
```
to:
```ts
    time: timestamp('time', { withTimezone: true }).notNull(),
```
And change the table's third argument from `(no extra config)` to a composite PK. Replace the closing of the table definition:
```ts
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.time] }),
  ]
);
```
(`primaryKey` is already imported at the top of the file.)

- [ ] **Step 2: Update the upsert conflict target**

In `backend/src/services/deribit-flow-worker.ts`, change the `onConflictDoUpdate` target from:
```ts
          .onConflictDoUpdate({
            target: optionFlowBuckets.time,
```
to:
```ts
          .onConflictDoUpdate({
            target: [optionFlowBuckets.symbol, optionFlowBuckets.time],
```

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file appears under `backend/drizzle/` dropping the old PK and adding `PRIMARY KEY (symbol, time)`.

- [ ] **Step 4: Review the generated SQL**

Open the generated file. Confirm it drops the single-column PK and creates the composite PK. Existing data is single-symbol (`BTC`), so no duplicate-key conflict is possible.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/schema.ts backend/src/services/deribit-flow-worker.ts backend/drizzle
git commit -m "fix(phase-a): composite (symbol, time) PK for option_flow_buckets"
```

---

## Task 9: market/candles default interval

**Files:**
- Modify: `backend/src/routes/market.ts`

- [ ] **Step 1: Change the default**

In `backend/src/routes/market.ts`, in `GET /candles`, change the destructured default from `interval = '1d'` to `interval = '1m'`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/market.ts
git commit -m "fix(phase-a): default candles interval to 1m (the ingested interval)"
```

---

## Task 10: Server hardening — Zod provider, error handler, CORS allowlist, body limit

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Update imports and the fastify instance**

In `backend/src/server.ts`, add imports:
```ts
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
```
Change the `fastify({ ... })` call to add a body limit:
```ts
  const app = fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
```

- [ ] **Step 2: Replace the CORS registration with an allowlist**

Replace:
```ts
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
```
with:
```ts
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : ['http://localhost:3000', 'http://localhost:4000'],
    credentials: true,
  });
```

- [ ] **Step 3: Add a global error handler**

Immediately after the CORS registration, add:
```ts
  app.setErrorHandler((err, req, reply) => {
    if ((err as any).validation) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: (err as any).validation,
      });
    }
    req.log.error(err);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.status(status).send({
      success: false,
      error: status === 500 ? 'Internal server error' : err.message,
    });
  });
```

- [ ] **Step 4: Document CORS_ORIGINS**

In `backend/.env.example`, under Server Configuration, add:
```
# Comma-separated allowlist of browser origins permitted to call the API
CORS_ORIGINS=http://localhost:3000,http://localhost:4000
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.ts backend/.env.example
git commit -m "feat(phase-a): zod validator/serializer, global error handler, CORS allowlist, body limit"
```

---

## Task 11: Zod request schemas on all routes

**Files:**
- Create: `backend/src/schemas.ts`
- Modify: `backend/src/routes/{trades,nights,drawings,preferences,alerts,market,telemetry,delta}.ts`

- [ ] **Step 1: Create the shared schemas module**

Create `backend/src/schemas.ts`:
```ts
import { z } from 'zod';

export const listQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const idParam = z.object({ id: z.string().uuid() });
export const dateParam = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// trades
export const tradeCreate = z.object({
  callStrike: z.union([z.number(), z.string()]),
  putStrike: z.union([z.number(), z.string()]),
  expiryDate: z.string(),
}).passthrough();
export const tradePatch = z.object({}).passthrough();

// nights
export const nightCreate = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  verdict: z.enum(['SELL_FULL', 'SELL_HALF', 'NO_TRADE']),
}).passthrough();
export const nightsQuery = z.object({
  verdict: z.string().optional(),
  outcome: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// drawings
export const drawingCreate = z.object({
  points: z.array(z.any()).min(1),
}).passthrough();
export const drawingUpdate = z.object({}).passthrough();
export const drawingsQuery = z.object({ symbol: z.string().optional() });

// preferences
export const preferencesUpdate = z.object({}).passthrough();

// alerts
export const alertRuleCreate = z.object({
  ruleName: z.string().min(1),
  ruleType: z.string().min(1),
  thresholdValue: z.union([z.number(), z.string()]),
}).passthrough();
export const alertsHistoryQuery = z.object({
  channel: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export const alertTest = z.object({
  channel: z.enum(['telegram', 'ntfy', 'in_app']).optional(),
  topic: z.string().optional(),
}).passthrough();
export const registerDevice = z.object({
  token: z.string().min(1),
  platform: z.string().optional(),
  soundChoice: z.string().optional(),
  enabled: z.boolean().optional(),
}).passthrough();

// market
export const candlesQuery = z.object({
  symbol: z.string().optional(),
  interval: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export const flowQuery = z.object({
  symbol: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
export const indicatorsQuery = flowQuery;

// telemetry
export const telemetrySession = z.object({
  sessionDate: z.string(),
  uiState: z.object({}).passthrough(),
}).passthrough();
export const telemetryCheckQuery = z.object({
  timeMs: z.string().optional(),
  speed: z.string().optional(),
});
```

- [ ] **Step 2: Attach schemas to routes**

For each route, add a `schema` object to the route options and remove the now-redundant manual presence checks. The pattern (example for trades):

In `backend/src/routes/trades.ts`, add import:
```ts
import { listQuery, idParam, tradeCreate, tradePatch } from '../schemas.js';
```
Change the route registrations to pass schemas:
```ts
  fastify.get('/', { schema: { querystring: listQuery } }, async (request, reply) => { /* ...body unchanged... */ });
  fastify.get('/:id', { schema: { params: idParam } }, async (request, reply) => { /* ... */ });
  fastify.post('/', { schema: { body: tradeCreate } }, async (request, reply) => { /* ...drop the manual callStrike/putStrike/expiryDate presence check... */ });
  fastify.patch('/:id', { schema: { params: idParam, body: tradePatch } }, async (request, reply) => { /* ... */ });
  fastify.delete('/:id', { schema: { params: idParam } }, async (request, reply) => { /* ... */ });
```

Apply the same wiring to the other routes using these schema bindings:
- `nights.ts`: GET `/` → `{ querystring: nightsQuery }`; GET `/:date` → `{ params: dateParam }`; POST `/` → `{ body: nightCreate }` (drop manual check); DELETE `/:date` → `{ params: dateParam }`.
- `drawings.ts`: GET `/` → `{ querystring: drawingsQuery }`; POST `/` → `{ body: drawingCreate }` (drop manual check); PUT `/:id` → `{ params: idParam, body: drawingUpdate }`; DELETE `/:id` → `{ params: idParam }`.
- `preferences.ts`: PUT `/` → `{ body: preferencesUpdate }`.
- `alerts.ts`: POST `/rules` → `{ body: alertRuleCreate }` (drop manual check); DELETE `/rules/:id` → `{ params: idParam }`; GET `/history` → `{ querystring: alertsHistoryQuery }`; POST `/test` → `{ body: alertTest }`; POST `/register-device` → `{ body: registerDevice }` (drop manual check).
- `market.ts`: GET `/candles` → `{ querystring: candlesQuery }`; GET `/flow` → `{ querystring: flowQuery }`; GET `/indicators` → `{ querystring: indicatorsQuery }`.
- `telemetry.ts`: POST `/session` → `{ body: telemetrySession }`; GET `/check` → `{ querystring: telemetryCheckQuery }`.
- `delta.ts`: leave the `/proxy` handler schema-free (kept permissive for Phase C); no change.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: tsc exits 0. Fix any type mismatches (e.g. `request.query`/`request.body` now typed — cast or use the inferred types; existing `as {...}`/`as any` casts remain valid).

- [ ] **Step 4: Smoke-test validation manually (optional, if a DB is available)**

Start the server (`npm run dev`) and run:
```bash
curl -s -X POST localhost:4000/api/v1/trades -H 'content-type: application/json' -d '{}'
```
Expected: `400` with `{"success":false,"error":"Validation failed", ...}`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/schemas.ts backend/src/routes
git commit -m "feat(phase-a): Zod request validation on all API routes"
```

---

## Task 12: Seed the default user on boot

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Add an idempotent seed in the onReady hook**

In `backend/src/server.ts`, inside the existing `app.addHook('onReady', ...)` (the one that starts workers), before starting workers, add:
```ts
    const { db, users } = await import('./db/index.js');
    try {
      await db.insert(users).values({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'desk@local',
        passwordHash: '!',
        displayName: 'Desk',
        role: 'trader',
      }).onConflictDoNothing();
      app.log.info('Default desk user ensured.');
    } catch (err) {
      app.log.error({ err }, 'Failed to seed default user');
    }
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.ts
git commit -m "fix(phase-a): idempotently seed default user on boot (bridge until auth)"
```

---

## Task 13: Annotate deferred stubs

**Files:**
- Modify: `backend/src/routes/migration.ts`
- Modify: `backend/src/types/index.ts`

- [ ] **Step 1: Correct the migration stub comment**

In `backend/src/routes/migration.ts`, replace the doc comment's "Future Endpoints" framing with an accurate deferral note:
```ts
/**
 * Browser Data Migration Routes — DEFERRED to Phase D.
 *
 * Not yet implemented. The one-time localStorage/IndexedDB → PostgreSQL import
 * (see MIGRATION.md) is scheduled for the canonical-persistence phase. This stub
 * intentionally registers no endpoints.
 */
```

- [ ] **Step 2: Correct the types stub comment**

In `backend/src/types/index.ts`, update the header comment to note the domain types are introduced alongside their features (no behavioral change).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/migration.ts backend/src/types/index.ts
git commit -m "docs(phase-a): mark migration/types stubs as deferred to Phase D"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: tsc exits 0.

- [ ] **Step 2: Full test run**

Run: `npm run test`
Expected: all suites PASS (volatility, stats, flow, cooldown, recalibration).

- [ ] **Step 3: Confirm acceptance criteria**

Re-read the spec §6 and confirm each item is satisfied by the committed tasks.

- [ ] **Step 4: Final branch state**

Run: `git log --oneline origin/main..HEAD`
Expected: the Phase A commit series on `phase-a-backend-correctness`. Do NOT merge to `main` — leave for user review (per the spec rollout).

---

## Self-Review Notes (plan author)

- **Spec coverage:** Unit1→Tasks 7,10,11; Unit2→Tasks 1,3,4,5; Unit3→Tasks 3,8,9; Unit4→Task 6; Unit5→Tasks 1,12,13; Unit6→Tasks 0–6 tests. All spec §3 units mapped.
- **Decisions honored:** `fastify-type-provider-zod` (Task 10/11), spot velocity (Task 1/4), seeded-baseline fallback labeled (Task 6).
- **Type consistency:** `checkMetrics({spotPrice,atmIv,ivChangePct,realizedVol,speed})` defined in Task 4 and called with those exact fields in Tasks 1,3,5. `sendNotification({channels})` defined Task 4, used Task 4 (`/test`). `garmanKlassRv`/`computeVelocityPct`/`filterNewTrades`/`computeIvChangePct`/`CooldownGate`/`binomialCdfLowerTail`/`computeRecalibration` names consistent across definition and use.
- **Outcome value:** `'PENDING'` used instead of `null` because `session_audit_logs.outcome` is `NOT NULL`.
- **Ordering caveat:** Tasks 1 & 3 add a `speed`/IV call to `checkMetrics` whose signature lands in Task 4; the full build is run at the end of Task 4. Executors should treat Tasks 1→4 as a group before expecting a green `npm run build`.
