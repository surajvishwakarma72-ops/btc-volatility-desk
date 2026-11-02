import { describe, expect, it } from 'vitest';
import { GLOSSARY_HI } from './glossary-hi.js';

const DEVANAGARI = /[ऀ-ॿ]/;
const REQUIRED = ['iv', 'rv', 'delta', 'theta', 'gamma', 'vega', 'oi', 'strangle', 'strike', 'lot', 'expiry', 'n2n', 'strangle pulse', 'sell zone', 'wait', 'avoid', 'no data', 'paper trade', 'live trade', 'stop loss', 'margin', 'premium'];

describe('GLOSSARY_HI', () => {
  it('has term, alias and Hindi text on every entry', () => {
    for (const e of GLOSSARY_HI) {
      expect(e.term).toBeTruthy();
      expect(e.aliases.length).toBeGreaterThan(0);
      expect(e.text).toMatch(DEVANAGARI);
    }
  });
  it('has unique terms', () => {
    const terms = GLOSSARY_HI.map((e) => e.term);
    expect(new Set(terms).size).toBe(terms.length);
  });
  it('covers every required term', () => {
    const terms = new Set(GLOSSARY_HI.map((e) => e.term));
    for (const t of REQUIRED) expect(terms.has(t), t).toBe(true);
  });
  it('says the Strangle Pulse score is not yet calibrated', () => {
    expect(GLOSSARY_HI.find((e) => e.term === 'strangle pulse')?.text).toContain('कैलिब्रेट');
  });
  it('never mentions the Flash ribbon', () => {
    expect(GLOSSARY_HI.some((e) => /flash/i.test(e.term))).toBe(false);
  });
});
