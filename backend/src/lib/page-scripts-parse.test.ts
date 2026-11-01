import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/** A browser silently drops a whole script block on one syntax error, and everything in that block stops working. */
describe('frontend/index.html', () => {
  it('has no inline script with a syntax error', () => {
    const html = readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8');
    const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
    const broken: string[] = [];
    let count = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      if (/type=["'](module|application|text\/(?!javascript))/.test(m[1]!)) continue;
      count += 1;
      try { new vm.Script(m[2]!); } catch (e) { broken.push(`${m[1]!.trim() || 'script'}: ${(e as Error).message}`); }
    }
    expect(count).toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });
});
