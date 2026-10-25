/**
 * Builds the searchable knowledge file for the "Ask me" chat from the project's own documents:
 * the markdown docs, the backtest report and rulebook, and the on-screen tooltips in the desk page.
 *
 *   npx tsx src/scripts/build-knowledge.ts
 *
 * Output: frontend/public/data/knowledge.json (served with the page; the server reads it at runtime).
 * The curated glossary lives in src/lib/ask/glossary.ts and is compiled into the server, not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkMarkdown, type KnowledgeEntry } from '../lib/ask/knowledge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const rd = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const DOCS = [
  'ARCHITECTURE.md',
  'ARCHITECTURE_AUDIT.md',
  'PRODUCTION_STRATEGY_REFERENCE_STAGE1_7.md',
  'DB_SCHEMA.md',
  'MIGRATION.md',
  'DEPLOY_ORACLE.md',
  'docs/OPERATIONS_HANDOFF.md',
  'backend/src/backtest/output/REPORT.md',
];

const FULL: Record<string, string> = { Mon: 'monday', Tue: 'tuesday', Wed: 'wednesday', Thu: 'thursday', Fri: 'friday', Sat: 'saturday', Sun: 'sunday' };
const entries: KnowledgeEntry[] = [];
for (const d of DOCS) {
  try {
    entries.push(...chunkMarkdown(path.basename(d), rd(d)));
  } catch {
    console.warn(`skipped ${d} (not found)`);
  }
}

// The machine-readable rulebook from the backtest, as one readable entry per weekday plus the global rules.
try {
  const rb = JSON.parse(rd('backend/src/backtest/output/rulebook.json')) as {
    generatedFrom: string;
    dataCaveats: string[];
    weekdays: Array<Record<string, unknown>>;
    global: Record<string, unknown>;
  };
  for (const w of rb.weekdays) {
    entries.push({
      id: `rulebook:${w.weekday}`,
      title: `Backtest rulebook: ${w.weekday}`,
      keywords: [String(w.weekday), String(w.weekday).toLowerCase(), FULL[String(w.weekday)] ?? '', 'rulebook', 'weekday verdict'],
      text: `${w.weekday}: verdict ${w.verdict}, conviction ${w.conviction}. Out-of-sample win rate ${w.oosWinPct}%, expectancy $${w.expectancyUsd} per trade over ${w.sampleSize} nights${w.fragile ? ' (fragile)' : ''}. Entry window ${w.earliest_entry} to ${w.latest_entry}. Source data: ${rb.generatedFrom}.`,
      source: 'rulebook.json',
    });
  }
  for (const [k, v] of Object.entries(rb.global)) {
    entries.push({
      id: `rulebook:global:${k}`,
      title: `Backtest rulebook: ${k.replace(/_/g, ' ')}`,
      keywords: ['rulebook', k.replace(/_/g, ' ')],
      text: JSON.stringify(v).slice(0, 1200),
      source: 'rulebook.json',
    });
  }
  entries.push({ id: 'rulebook:caveats', title: 'Backtest data caveats', keywords: ['caveats', 'limitations', 'data caveats'], text: rb.dataCaveats.join(' '), source: 'rulebook.json' });
} catch {
  console.warn('skipped rulebook.json');
}

// Static tooltips from the page (those with dynamic ${...} parts are skipped).
const html = rd('frontend/index.html');
const seen = new Set<string>();
for (const m of html.matchAll(/\btitle="([^"<>]{50,400})"/g)) {
  const t = m[1]!;
  if (t.includes('${') || seen.has(t)) continue;
  seen.add(t);
  entries.push({ id: `tooltip:${entries.length}`, title: 'On-screen tooltip', keywords: [], text: t, source: 'tooltip' });
}

const out = path.join(root, 'frontend/public/data/knowledge.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ builtAt: new Date().toISOString(), entries }));
const bySource = new Map<string, number>();
for (const e of entries) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
console.log(`wrote ${out}: ${entries.length} entries, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
for (const [s, n] of bySource) console.log(`  ${s}: ${n}`);
