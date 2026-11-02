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
const V = new Function(`${html.slice(a, b)}\nreturn { hindiNumber, parseHindiNumber, normalizeHi, matchIntent, composeReply, createVoiceSession };`)() as any;

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

const NA = 'माफ कीजिए, ये जानकारी उपलब्ध नहीं है। इसके अलावा आप कुछ और पूछ सकते हैं।';
const GREETING = 'नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?';
const pulse = { card: { verdict: 'SELL NOW', zone: 'sell', confidence: 74.4, why: ['x'], vetoes: [] } };

describe('composeReply', () => {
  it('reads the Pulse verdict', () => {
    const r = V.composeReply({ id: 'market' }, { pulse });
    expect(r).toContain('SELL ZONE');
    expect(r).toContain('चौहत्तर प्रतिशत');
  });
  it('reads a known veto in Hindi and skips an unknown one', () => {
    const c = { ...pulse.card, verdict: 'AVOID', zone: 'avoid', confidence: 40, vetoes: ['Term structure inverted', 'Something new'] };
    const r = V.composeReply({ id: 'market' }, { pulse: { card: c } });
    expect(r).toContain('टर्म');
    expect(r).not.toContain('Something');
  });
  it('never invents a market reading', () => {
    expect(V.composeReply({ id: 'market' }, { pulse: { card: null } })).toBe(NA);
    expect(V.composeReply({ id: 'market' }, { pulse: null })).toBe(NA);
    expect(V.composeReply({ id: 'market' }, {})).toBe(NA);
    expect(V.composeReply({ id: 'market' }, { pulse: { card: { ...pulse.card, verdict: 'NO DATA', confidence: null } } })).toBe(NA);
  });
  it('explains from the glossary, then adds the live reading', () => {
    const glossary = [{ term: 'iv', aliases: ['आईवी'], text: 'टेस्ट' }, { term: 'strangle pulse', aliases: ['x'], text: 'पल्स', metric: 'pulse' }];
    expect(V.composeReply({ id: 'explain', term: 'iv' }, { glossary })).toBe('टेस्ट');
    expect(V.composeReply({ id: 'explain', term: 'zzz' }, { glossary: [] })).toBe(NA);
    expect(V.composeReply({ id: 'explain', term: 'strangle pulse' }, { glossary, pulse })).toContain('चौहत्तर प्रतिशत');
    expect(V.composeReply({ id: 'explain', term: 'strangle pulse' }, { glossary, pulse: null })).toBe('पल्स');
  });
  it('reads positions', () => {
    expect(V.composeReply({ id: 'positions' }, { positions: { paper: [], delta: [], deltaNote: null } })).toContain('कोई खुली पोज़िशन नहीं');
    const r = V.composeReply({ id: 'positions' }, { positions: { paper: [{ id: '1', name: 'a', netPnl: 25.4, legs: 2 }], delta: [{ symbol: 'C-BTC', size: 3, entry: 10 }], deltaNote: null } });
    expect(r).toContain('एक पेपर');
    expect(r).toContain('एक असली');
    expect(r).toContain('फायदा पच्चीस डॉलर');
    expect(V.composeReply({ id: 'positions' }, { positions: { paper: [{ id: '1', name: 'a', netPnl: -3, legs: 2 }], delta: [], deltaNote: null } })).toContain('नुकसान तीन डॉलर');
    expect(V.composeReply({ id: 'positions' }, {})).toBe(NA);
  });
  it('never says "no positions" when real positions could not be read', () => {
    const r = V.composeReply({ id: 'positions' }, { positions: { paper: [], delta: [], deltaNote: 'failed' } });
    expect(r).toContain('असली पोज़िशन नहीं देख पाई');
    expect(r).not.toContain('कोई खुली पोज़िशन नहीं');
  });
  it('keeps entry unavailable and says when a request failed', () => {
    expect(V.composeReply({ id: 'entry' }, {})).toContain('अभी उपलब्ध नहीं');
    expect(V.composeReply({ id: 'help' }, {})).toContain('बाज़ार कैसा है');
    expect(V.composeReply({ id: 'unknown' }, {})).toBe(NA);
    expect(V.composeReply({ id: 'market' }, { failed: true })).toContain('दिक्कत');
  });
});

function rig(opts: any = {}) {
  const log: string[] = [], lines: string[] = [], status: string[] = [], pages: string[] = [], spoken: any[] = [];
  let timers: any[] = [];
  const s = V.createVoiceSession({
    input: { start: () => log.push('in:start'), stop: () => log.push('in:stop') },
    output: { speak: async (t: string, rate: number) => { log.push('say'); spoken.push({ t, rate }); }, cancel: () => log.push('cancel'), hasHindiVoice: () => opts.voice !== false },
    fetchData: opts.fetchData ?? (async () => ({ pulse, glossary: [] })),
    navigate: (p: string) => pages.push(p),
    onStatus: (x: string) => status.push(x),
    onLine: (who: string, t: string) => lines.push(who + ':' + t),
    timers: { set: (fn: () => void, ms: number) => { const id = { fn, ms }; timers.push(id); return id; }, clear: (id: any) => { timers = timers.filter((x) => x !== id); } },
  });
  const fire = async () => { const t = timers.shift(); await t.fn(); await tick(); return t.ms; };
  return { s, log, lines, status, pages, spoken, fire, pending: () => timers.length };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('createVoiceSession', () => {
  it('greets, and listens only after speaking ends', async () => {
    const r = rig();
    await r.s.start(); await tick();
    expect(r.spoken[0].t).toBe(GREETING);
    expect(r.log.indexOf('say')).toBeLessThan(r.log.indexOf('in:start'));
  });
  it('stops listening before every reply, so it never hears itself', async () => {
    const r = rig();
    await r.s.start(); await tick();
    r.log.length = 0;
    await r.s.hear('आज बाज़ार कैसा है'); await tick();
    expect(r.log.indexOf('in:stop')).toBeGreaterThanOrEqual(0);
    expect(r.log.indexOf('in:stop')).toBeLessThan(r.log.indexOf('say'));
  });
  it('prompts after 8 s of silence and closes 30 s later', async () => {
    const r = rig();
    await r.s.start(); await tick();
    expect(await r.fire()).toBe(8000);
    expect(r.spoken.at(-1).t).toBe('क्या आप कुछ और पूछना चाहेंगे?');
    expect(await r.fire()).toBe(30000);
    expect(r.spoken.at(-1).t).toBe('ठीक है, जब ज़रूरत हो मुझे बुला लीजिए।');
    expect(r.status).toContain('closed');
    expect(r.pending()).toBe(0);
  });
  it('repeats and slows down', async () => {
    const r = rig();
    await r.s.start(); await tick();
    await r.s.hear('आज बाज़ार कैसा है'); await tick();
    const last = r.spoken.at(-1).t;
    await r.s.hear('फिर से बोलो'); await tick();
    expect(r.spoken.at(-1).t).toBe(last);
    await r.s.hear('धीरे बोलो'); await tick();
    expect(r.spoken.at(-1).rate).toBe(0.8);
  });
  it('opens a page', async () => {
    const r = rig();
    await r.s.start(); await tick();
    await r.s.hear('पेपर पेज दिखाओ'); await tick();
    expect(r.pages).toEqual(['pgPaper']);
  });
  it('says so when data fails, and keeps listening', async () => {
    const r = rig({ fetchData: async (k: string) => { if (k === 'glossary') return { glossary: [] }; throw new Error('401'); } });
    await r.s.start(); await tick();
    r.log.length = 0;
    await r.s.hear('आज बाज़ार कैसा है'); await tick();
    expect(r.spoken.at(-1).t).toContain('दिक्कत');
    expect(r.log).toContain('in:start');
  });
  it('still shows the reply when the device has no Hindi voice', async () => {
    const r = rig({ voice: false });
    await r.s.start(); await tick();
    expect(r.status).toContain('no-hindi-voice');
    expect(r.lines).toContain('bot:' + GREETING);
  });
  it('ignores speech while a reply is in progress', async () => {
    let release: (v: unknown) => void = () => {};
    const r = rig({ fetchData: (k: string) => (k === 'glossary' ? Promise.resolve({ glossary: [] }) : new Promise((res) => { release = res; })) });
    await r.s.start(); await tick();
    const first = r.s.hear('आज बाज़ार कैसा है');
    await r.s.hear('मेरी पोजीशन कैसी है');
    release({ pulse }); await first; await tick();
    expect(r.lines.filter((l) => l.startsWith('me:'))).toHaveLength(1);
  });
  it('ignores speech after it is stopped', async () => {
    const r = rig();
    await r.s.start(); await tick();
    r.s.stop();
    await r.s.hear('आज बाज़ार कैसा है'); await tick();
    expect(r.lines.some((l) => l.startsWith('me:'))).toBe(false);
    expect(r.log).toContain('cancel');
  });
});
