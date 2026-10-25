import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

describe('the built docs index (frontend/public/data/knowledge.json)', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data/knowledge.json');
  it('exists, is large enough, and answers questions from the real docs', () => {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: KnowledgeEntry[] };
    expect(j.entries.length).toBeGreaterThan(100);
    const all = [...GLOSSARY, ...j.entries];
    expect(top('where do the data caches live on the oracle vm deployment', j.entries)).toBeDefined();
    expect(top('what is the stop rate on thursdays', all)).toBeDefined();
    expect(new Set(j.entries.map((e) => e.source)).has('PRODUCTION_STRATEGY_REFERENCE_STAGE1_7.md')).toBe(true);
    expect(j.entries.some((e) => e.id.startsWith('rulebook:'))).toBe(true);
  });
});

describe('evidence questions', () => {
  it('"how many nights were tested" finds the data-span entry, not the trading sessions entry', () => {
    expect(top('how many nights were tested')?.entry.id).toBe('glossary:evidence');
    expect(top('what is the sample size of the backtest')?.entry.id).toBe('glossary:evidence');
    expect(top('what are the trading sessions')?.entry.id).toBe('glossary:sessions');
  });
});
