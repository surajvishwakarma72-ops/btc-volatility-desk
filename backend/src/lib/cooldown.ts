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
