import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findSensitive } from './sensitive.js';
import { DOCS_INDEX } from './docs-index.generated.js';
import { GLOSSARY } from './glossary.js';
import { KNOWLEDGE_MIN_SCORE, chunkMarkdown, searchKnowledge, tokens, type KnowledgeEntry } from './knowledge.js';

const top = (q: string, entries: readonly KnowledgeEntry[] = GLOSSARY) => searchKnowledge(q, entries, 3)[0];

describe('tokens', () => {
  it('drops filler words, keeps terms and simple stems', () => {
    expect(tokens('What is the Risk-ADX line?')).toEqual(expect.arrayContaining(['risk-adx', 'line']));
    expect(tokens('what is the')).toEqual([]);
    expect(tokens('strangles')).toEqual(expect.arrayContaining(['strangles', 'strangle']));
  });
});

describe('glossary search', () => {
  it('finds the right concept for the way the desk owner would ask', () => {
    const cases: Array<[string, string]> = [
      ['what is n2n', 'glossary:n2n'],
      ['explain next to next expiry', 'glossary:n2n'],
      ['what is vol of vol', 'glossary:vov'],
      ['what does vov falling mean', 'glossary:vov'],
      ['what is dvol', 'glossary:dvol'],
      ['what is the risk adx', 'glossary:riskadx'],
      ['how does the entry gauge turn green', 'glossary:gauge'],
      ['what is the usual fall bar', 'glossary:usualfall'],
      ['difference between contango and backwardation', 'glossary:term'],
      ['what is the go or wait gate', 'glossary:gate'],
      ['why is thursday skipped', 'glossary:weekday'],
      ['what is a calendar spread', 'glossary:calendar'],
      ['what is an iron condor', 'glossary:condor'],
      ['what is portfolio margin', 'glossary:margin'],
      ['what is the kill switch', 'glossary:killswitch'],
      ['what is bonferroni', 'glossary:recal'],
      ['what is the speed beacon', 'glossary:speed'],
      ['what is dealer gamma', 'glossary:gex'],
      ['what is the macro stress score', 'glossary:macro'],
      ['what is 30d audit', 'glossary:audit30'],
    ];
    for (const [q, id] of cases) {
      const h = top(q);
      expect(h?.entry.id, q).toBe(id);
      expect(h!.score, q).toBeGreaterThanOrEqual(KNOWLEDGE_MIN_SCORE);
    }
  });

  it('abbreviations expand ("oi" finds open interest, "rv" finds realised volatility)', () => {
    expect(top('what is oi')?.entry.id).toBe('glossary:oi');
    expect(top('what is rv fast')?.entry.id).toBe('glossary:rv');
  });

  it('scores nonsense below the answer threshold so the bot says it does not know', () => {
    for (const q of ['what is flurbo glorp', 'zebra protocol', 'tell me about quantum bananas']) {
      const h = top(q);
      expect(!h || h.score < KNOWLEDGE_MIN_SCORE, q).toBe(true);
    }
  });

  it('every glossary entry is well formed and unique', () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSARY) {
      expect(e.title.length, e.id).toBeGreaterThan(2);
      expect(e.text.length, e.id).toBeGreaterThan(80);
      expect(e.keywords.length, e.id).toBeGreaterThan(0);
      // each entry is findable by its own title
      expect(top(e.title)?.entry.id, e.id).toBe(e.id);
    }
    expect(GLOSSARY.length).toBeGreaterThan(40);
  });
});

describe('chunkMarkdown', () => {
  it('splits on headings, keeps the heading as the title, and drops tiny fragments', () => {
    const md = '# Top\n\nintro text that is long enough to keep as a chunk for the index here.\n\n## Rules\n\n' + 'Thursday is skipped because of the Sunday expiry shock. '.repeat(3) + '\n\n### Tiny\n\nx\n';
    const c = chunkMarkdown('DOC.md', md);
    expect(c.map((e) => e.title)).toEqual(['Top', 'Rules']);
    expect(c[1]!.source).toBe('DOC.md');
    expect(top('why is thursday skipped', c)?.entry.title).toBe('Rules');
  });

  it('cuts long sections into parts', () => {
    const c = chunkMarkdown('BIG.md', '## Long\n\n' + 'word '.repeat(1000), 1000);
    expect(c.length).toBeGreaterThan(2);
    expect(c[1]!.title).toBe('Long (part 2)');
  });
});

describe('the built docs index (compiled into the server)', () => {
  it('is large enough and answers questions from the real design docs', () => {
    expect(DOCS_INDEX.length).toBeGreaterThan(100);
    expect(top('what is the stop rate on thursdays', [...GLOSSARY, ...DOCS_INDEX])).toBeDefined();
    expect(new Set(DOCS_INDEX.map((e) => e.source)).has('PRODUCTION_STRATEGY_REFERENCE_STAGE1_7.md')).toBe(true);
    expect(DOCS_INDEX.some((e) => e.id.startsWith('rulebook:'))).toBe(true);
  });

  it('leaves out the deployment and operations documents', () => {
    const sources = new Set(DOCS_INDEX.map((e) => e.source));
    for (const s of ['DEPLOY_ORACLE.md', 'OPERATIONS_HANDOFF.md', 'MIGRATION.md']) expect(sources.has(s), s).toBe(false);
  });

  it('contains nothing that looks like an address, an SSH login, a key path, a connection string or a token', () => {
    const bad = DOCS_INDEX.flatMap((e) => findSensitive(`${e.title}\n${e.text}`).map((p) => `${e.id}: ${p}`));
    expect(bad).toEqual([]);
    const glossaryBad = GLOSSARY.flatMap((e) => findSensitive(`${e.title}\n${e.text}`).map((p) => `${e.id}: ${p}`));
    expect(glossaryBad).toEqual([]);
  });

  it('the sensitive-text detector catches the things it is meant to', () => {
    expect(findSensitive('ssh -i ~/.ssh/oracle_key ubuntu@host')).toEqual(expect.arrayContaining(['SSH target', 'SSH key path']));
    expect(findSensitive('connect to 192.168.1.20')).toContain('IPv4 address');
    expect(findSensitive('postgres://user:pw@db.example.com/x')).toContain('connection string');
    expect(findSensitive('https://my.duckdns.org/x')).toContain('duckdns host');
    expect(findSensitive('the Binance stream btcusdt@aggTrade is fine')).toEqual([]);
  });

  it('is never published as a file in the public web folder', () => {
    const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
    expect(fs.readdirSync(pub).filter((f) => /knowledge/i.test(f))).toEqual([]);
  });
});

describe('evidence questions', () => {
  it('"how many nights were tested" finds the data-span entry, not the trading sessions entry', () => {
    expect(top('how many nights were tested')?.entry.id).toBe('glossary:evidence');
    expect(top('what is the sample size of the backtest')?.entry.id).toBe('glossary:evidence');
    expect(top('what are the trading sessions')?.entry.id).toBe('glossary:sessions');
  });
});
