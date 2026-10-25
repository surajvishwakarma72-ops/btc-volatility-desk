import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let cache: { at: number; data: any | null } | null = null;

/** The historical replay results (bot_replay.json) as built by `scripts/bot-replay.ts`, cached for ten minutes. */
export function loadReplay(): any | null {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const candidates = [
    path.resolve(here, '../../../../frontend/dist/data/bot_replay.json'),
    path.resolve(here, '../../../../frontend/public/data/bot_replay.json'),
    path.resolve(process.cwd(), 'frontend/dist/data/bot_replay.json'),
    path.resolve(process.cwd(), '../frontend/dist/data/bot_replay.json'),
  ];
  let data: any | null = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      }
    } catch { /* try the next location */ }
  }
  cache = { at: Date.now(), data };
  return data;
}
