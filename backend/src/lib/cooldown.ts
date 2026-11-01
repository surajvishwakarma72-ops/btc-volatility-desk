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

/** Rate limiter that tracks attempts per key/IP over a rolling window. */
export class LoginCooldownTracker {
  private attempts = new Map<string, number[]>();

  check(ip: string, maxAttempts = 5, windowMs = 600_000, nowMs = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const history = (this.attempts.get(ip) ?? []).filter((t) => nowMs - t < windowMs);
    if (history.length >= maxAttempts) {
      const oldest = history[0];
      const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      return { allowed: false, retryAfterSeconds: retryAfter };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  record(ip: string, nowMs = Date.now()): void {
    const history = (this.attempts.get(ip) ?? []).filter((t) => nowMs - t < 600_000);
    history.push(nowMs);
    this.attempts.set(ip, history);
  }

  /** Removes only the newest attempt. Clearing the whole history here would let someone with a valid login wipe their wrong guesses. */
  forgetLast(ip: string): void {
    this.attempts.get(ip)?.pop();
  }

  reset(ip?: string): void {
    if (ip) this.attempts.delete(ip);
    else this.attempts.clear();
  }
}

export const loginCooldown = new LoginCooldownTracker();
