/**
 * Small keyword search over the terminal's own written knowledge (a curated glossary plus text cut
 * from the project docs and on-screen tooltips). Deterministic and offline: it ranks entries by how
 * many of the question's meaningful words appear in their title, keywords and body.
 */
export interface KnowledgeEntry {
  id: string;
  title: string;
  /** Alternative names and abbreviations people type. */
  keywords: string[];
  text: string;
  /** Where it came from: "glossary", a doc file name, or "tooltip". */
  source: string;
}

const STOP = new Set(
  'a an the is are was were be been being of for to in on at by with from and or but if then than that this these those it its as do does did what whats which who whom how why when where can could should would will shall may might me my mine you your i we they them their there here about into over under up down out so such very just also any some all more most much many tell explain describe define meaning mean means please give show terminal desk bot ask difference differences between versus compare compared differ work works happen happens happened happening go goes get gets use uses used want'.split(' '),
);

/** Common ways the desk's terms are written, expanded so "vol of vol" finds VoV. */
const SYNONYMS: Record<string, string[]> = {
  vov: ['vol', 'of', 'vol', 'volatility'],
  iv: ['implied', 'volatility'],
  rv: ['realised', 'realized', 'volatility'],
  dvol: ['deribit', 'volatility', 'index'],
  oi: ['open', 'interest'],
  gex: ['gamma', 'dealer'],
  rr: ['risk', 'reversal', 'skew'],
  tp: ['take', 'profit'],
  sl: ['stop', 'loss'],
  ic: ['iron', 'condor'],
  adx: ['trend', 'strength'],
  cvd: ['cumulative', 'volume', 'delta'],
  oos: ['out', 'of', 'sample'],
  n2n: ['next', 'to', 'next', 'expiry'],
};

export function tokens(q: string): string[] {
  const raw = q.toLowerCase().replace(/[^a-z0-9_+.\-\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const w of raw) {
    const t = w.replace(/^[-.]+|[-.]+$/g, '');
    if (!t || STOP.has(t)) continue;
    out.push(t);
    if (t.includes('-')) for (const part of t.split('-')) if (part.length > 1 && !STOP.has(part)) out.push(part);
    // light stemming: strangles -> strangle, spreads -> spread, stopped -> stop
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1));
    if (t.length > 5 && t.endsWith('ed')) out.push(t.slice(0, -2));
    if (t.length > 5 && t.endsWith('ing')) out.push(t.slice(0, -3));
  }
  return [...new Set(out)];
}

function expand(ts: string[]): string[] {
  const out = new Set(ts);
  for (const t of ts) for (const s of SYNONYMS[t] ?? []) out.add(s);
  return [...out];
}

export interface Hit {
  entry: KnowledgeEntry;
  score: number;
  /** Share of the question's meaningful words (counting stems and abbreviations as one) found in the entry. */
  coverage: number;
  /** Share (by weight) of the question's words that appear in NO entry at all: a sign the question is out of scope. */
  unknownShare: number;
}

/** One group per meaningful word in the question: the word plus its stems. */
function tokenGroups(q: string): string[][] {
  const raw = q.toLowerCase().replace(/[^a-z0-9_+.\-\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[][] = [];
  for (const w of raw) {
    const t = w.replace(/^[-.]+|[-.]+$/g, '');
    if (!t || STOP.has(t)) continue;
    const g = [t];
    if (t.includes('-')) for (const part of t.split('-')) if (part.length > 1 && !STOP.has(part)) g.push(part);
    if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) g.push(t.slice(0, -1));
    if (t.length > 5 && t.endsWith('ed')) g.push(t.slice(0, -2));
    if (t.length > 5 && t.endsWith('ing')) g.push(t.slice(0, -3));
    out.push(expand(g));
  }
  return out;
}

/**
 * Ranking: for every meaningful word in the question, a BM25-style score over the entry's text (a word
 * that is rare across all entries counts more than a common one, and repeats saturate), plus a strong
 * boost when the word is in the entry's title or keywords, plus a bonus when the question contains the
 * entry's exact name. Short generic keywords ("stop", "go") get a small exact-name bonus; specific
 * ones ("risk adx", "30d audit") a large one.
 */
export function searchKnowledge(query: string, entries: readonly KnowledgeEntry[], limit = 3): Hit[] {
  const qTokens = tokens(query);
  if (!qTokens.length || !entries.length) return [];
  const q = expand(qTokens);
  const qLower = ` ${query.toLowerCase().replace(/[^a-z0-9_+.\-\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const N = entries.length;
  const prepared = entries.map((e) => {
    const bodyTokens = tokens(`${e.title} ${e.text}`);
    const tf = new Map<string, number>();
    for (const w of bodyTokens) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { e, tf, len: bodyTokens.length, head: new Set(expand(tokens(`${e.title} ${e.keywords.join(' ')}`))) };
  });
  const df = new Map<string, number>();
  for (const p of prepared) for (const w of new Set([...p.tf.keys(), ...p.head])) df.set(w, (df.get(w) ?? 0) + 1);
  const avgLen = prepared.reduce((s, p) => s + p.len, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.6;
  const groups = tokenGroups(query);
  const hits: Hit[] = [];
  for (const p of prepared) {
    let score = 0;
    for (const t of q) {
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      const f = p.tf.get(t) ?? 0;
      if (f > 0) score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * p.len) / avgLen)));
      if (p.head.has(t)) score += 3 * idf;
    }
    for (const k of [p.e.title, ...p.e.keywords]) {
      const kl = ` ${k.toLowerCase()} `;
      if (k.length > 1 && qLower.includes(kl)) score += /[^a-z ]/.test(k) || k.length >= 6 ? 8 : 2;
    }
    if (score > 0) {
      // weighted coverage: a rare word that is missing (or absent from every entry) costs a lot, a common filler word little
      let have = 0;
      let all = 0;
      let unknown = 0;
      for (const g of groups) {
        const w = Math.max(...g.map((x) => Math.log(1 + (N - (df.get(x) ?? 0) + 0.5) / ((df.get(x) ?? 0) + 0.5))));
        all += w;
        if (g.some((x) => p.tf.has(x) || p.head.has(x))) have += w;
        else if (g.every((x) => !df.has(x)) && g[0]!.length >= 4) unknown += w;
      }
      hits.push({ entry: p.e, score, coverage: all > 0 ? have / all : 0, unknownShare: all > 0 ? unknown / all : 0 });
    }
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit);
}

/**
 * An answer must also cover most of what was asked: more than half of the question's words (weighted by
 * how rare each is) have to appear in the entry, so a single shared word ("today") cannot answer a different question.
 */
export const KNOWLEDGE_MIN_COVERAGE = 0.45;

/** If more than this share of the question is made of words that exist nowhere in the knowledge, say we do not know. */
export const KNOWLEDGE_MAX_UNKNOWN = 0.3;

/** Below this the best hit is probably a coincidence and we say we do not know. */
export const KNOWLEDGE_MIN_SCORE = 6;

/** Cut a doc into heading-sized pieces for the knowledge index. */
export function chunkMarkdown(file: string, md: string, maxChars = 1400): KnowledgeEntry[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: KnowledgeEntry[] = [];
  let title = file;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 60) return;
    for (let i = 0, part = 1; i < text.length; i += maxChars, part++) {
      const piece = text.slice(i, i + maxChars).trim();
      if (piece.length < 60) continue;
      out.push({ id: `${file}#${out.length}`, title: part > 1 ? `${title} (part ${part})` : title, keywords: [], text: piece, source: file });
    }
  };
  for (const line of lines) {
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      buf = [];
      title = h[1]!.replace(/[*`_]/g, '').trim();
    } else buf.push(line);
  }
  flush();
  return out;
}
