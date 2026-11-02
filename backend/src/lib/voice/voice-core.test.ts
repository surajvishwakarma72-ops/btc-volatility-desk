import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Hindi voice core lives in frontend/index.html. Its pure part sits between VOICE-CORE markers, so these tests
 * run that exact code.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// VOICE-CORE-START'), b = html.indexOf('// VOICE-CORE-END');
if (a < 0 || b < 0) throw new Error('VOICE markers not found in frontend/index.html');
const V = new Function(`${html.slice(a, b)}\nreturn { hindiNumber, parseHindiNumber, normalizeHi, matchIntent };`)() as any;

describe('hindiNumber', () => {
  it('speaks numbers the Indian way', () => {
    expect(V.hindiNumber(68000)).toBe('अड़सठ हज़ार');
    expect(V.hindiNumber(120000)).toBe('एक लाख बीस हज़ार');
    expect(V.hindiNumber(2400)).toBe('दो हज़ार चार सौ');
    expect(V.hindiNumber(0)).toBe('शून्य');
  });
});

describe('parseHindiNumber', () => {
  it('reads Hindi number words', () => {
    expect(V.parseHindiNumber('अड़सठ हज़ार')).toBe(68000);
    expect(V.parseHindiNumber('डेढ़')).toBe(1.5);
    expect(V.parseHindiNumber('ढाई')).toBe(2.5);
    expect(V.parseHindiNumber('साढ़े सात')).toBe(7.5);
    expect(V.parseHindiNumber('सवा दो')).toBe(2.25);
    expect(V.parseHindiNumber('12')).toBe(12);
  });
  it('returns null when there is no number', () => {
    expect(V.parseHindiNumber('मौसम')).toBeNull();
    expect(V.parseHindiNumber('')).toBeNull();
  });
});

describe('matchIntent', () => {
  it('finds market, positions, help and entry', () => {
    expect(V.matchIntent('आज बाज़ार कैसा है?').id).toBe('market');
    expect(V.matchIntent('आज बाजार कैसा है').id).toBe('market');
    expect(V.matchIntent('मेरी पोजीशन कैसी है').id).toBe('positions');
    expect(V.matchIntent('एंट्री करनी है').id).toBe('entry');
    expect(V.matchIntent('मदद').id).toBe('help');
    expect(V.matchIntent('फिर से बोलो').id).toBe('repeat');
    expect(V.matchIntent('धीरे बोलो').id).toBe('slower');
  });
  it('explains known terms, in either spelling', () => {
    expect(V.matchIntent('IV क्या है')).toMatchObject({ id: 'explain', term: 'iv' });
    expect(V.matchIntent('आईवी क्या है')).toMatchObject({ id: 'explain', term: 'iv' });
    expect(V.matchIntent('Strangle Pulse क्या है')).toMatchObject({ id: 'explain', term: 'strangle pulse' });
    expect(V.matchIntent('स्टॉप लॉस का मतलब समझाओ')).toMatchObject({ id: 'explain', term: 'stop loss' });
  });
  it('opens pages', () => {
    expect(V.matchIntent('पेपर पेज दिखाओ')).toMatchObject({ id: 'navigate', page: 'pgPaper' });
    expect(V.matchIntent('सेटिंग खोलो')).toMatchObject({ id: 'navigate', page: 'pgSettings' });
  });
  it('treats anything else as unknown', () => {
    expect(V.matchIntent('आज क्रिकेट का स्कोर क्या है').id).toBe('unknown');
    expect(V.matchIntent('नहीं').id).toBe('unknown');
    expect(V.matchIntent('').id).toBe('unknown');
    expect(V.matchIntent('hello world').id).toBe('unknown');
  });
});
