import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'backtest' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const orderFiles = sources(SRC).filter((f) => !f.endsWith(join('routes', 'delta.ts')) && /deltaSigned(Post|Delete)\(/.test(readFileSync(f, 'utf8')));

describe('order signing', () => {
  it('happens only in the three known order paths', () => {
    expect(orderFiles.map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/')).sort()).toEqual(['services/algo/live-entry.ts', 'services/watch/auto-stop.ts', 'services/watch/live-exit.ts']);
  });

  it('uses the order key and no other key source in those paths', () => {
    for (const f of orderFiles) {
      const text = readFileSync(f, 'utf8');
      expect(text).toContain('loadOrderKey');
      expect(text).not.toContain('loadDeltaKey');
      expect(text).not.toContain('process.env.DELTA_API');
    }
  });

  it('takes the order key from the trade slot only', () => {
    const text = readFileSync(join(SRC, 'services', 'delta-keys.ts'), 'utf8');
    expect(text).toMatch(/function loadOrderKey[\s\S]*?\{\r?\n\s*return loadDeltaKey\(userId, 'trade'\);\r?\n\}/);
  });
});
