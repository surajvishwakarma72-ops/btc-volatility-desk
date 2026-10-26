import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStrangle, strategySchema } from '../algo/rule.js';

/** The guided "algo trading" wizard in Ask me: its pure core sits between WIZARD-CORE markers in frontend/index.html. */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const slice = (a: string, b: string) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < 0) throw new Error('markers missing: ' + a); return html.slice(i, j); };
const P = new Function(`${slice('// ASKTRADE-CORE-START', '// ASKTRADE-CORE-END')}\nreturn { parsePatch, applyPatch, parseChoice };`)();
const W = new Function('P', `${slice('// WIZARD-CORE-START', '// WIZARD-CORE-END')}\nreturn makeWizardCore(P);`)(P) as any;

const base = () => JSON.parse(JSON.stringify(defaultStrangle()));
const fresh = (when = 'later', lots = 50) => ({ rule: base(), lots, when });
const ok = (r: unknown) => strategySchema.safeParse(r);

describe('which steps apply', () => {
  it('an option goes through delta and expiry; a schedule adds the entry steps; a window adds conditions', () => {
    const w = fresh();
    expect(W.steps(w)).toEqual(['kind', 'delta', 'expiry', 'when', 'entry', 'time', 'days', 'stops', 'exittime', 'lots', 'mode', 'review']);
    w.rule.entry = { kind: 'window', from: '22:30', to: '01:30', conditions: [] };
    expect(W.steps(w)).toContain('conditions');
    expect(W.steps(fresh('now'))).toEqual(['kind', 'delta', 'expiry', 'when', 'stops', 'exittime', 'lots', 'mode', 'review']);
  });
  it('a future skips delta and expiry', () => {
    const w = fresh('now'); w.rule = P.applyPatch(w.rule, { legs: 'future', side: 'long' });
    expect(W.steps(w)).toEqual(['kind', 'when', 'stops', 'exittime', 'lots', 'mode', 'review']);
  });
});

describe('reading answers', () => {
  const w = fresh();
  it('kind', () => {
    expect(W.parseAnswer('kind', 'strangle', w).patch).toMatchObject({ legs: 'strangle' });
    expect(W.parseAnswer('kind', 'straddle', w).patch).toMatchObject({ legs: 'straddle' });
    expect(W.parseAnswer('kind', 'call', w).patch).toMatchObject({ legs: 'call' });
    expect(W.parseAnswer('kind', 'long', w).patch).toMatchObject({ legs: 'future', side: 'long' });
    expect(W.parseAnswer('kind', 'future short', w).patch).toMatchObject({ legs: 'future', side: 'short' });
    expect(W.parseAnswer('kind', 'banana', w).ok).toBe(false);
  });
  it('delta, 10 and 0.10 mean the same', () => {
    expect(W.parseAnswer('delta', '0.10', w).patch.deltaTarget).toBe(0.1);
    expect(W.parseAnswer('delta', '12', w).patch.deltaTarget).toBeCloseTo(0.12);
    expect(W.parseAnswer('delta', 'a lot', w).ok).toBe(false);
  });
  it('expiry words', () => {
    expect(W.parseAnswer('expiry', '0dte', w).patch.expiry.mode).toBe('current');
    expect(W.parseAnswer('expiry', 'next (1DTE)', w).patch.expiry.mode).toBe('next');
    expect(W.parseAnswer('expiry', 'next to next', w).patch.expiry.mode).toBe('n2n');
    expect(W.parseAnswer('expiry', 'n2n', w).patch.expiry.mode).toBe('n2n');
  });
  it('when, entry and times', () => {
    expect(W.parseAnswer('when', 'now', w).when).toBe('now');
    expect(W.parseAnswer('when', 'schedule', w).when).toBe('later');
    expect(W.parseAnswer('entry', 'hard', w).entryKind).toBe('hard');
    expect(W.parseAnswer('entry', 'window', w).entryKind).toBe('window');
    expect(W.parseAnswer('time', '10:30 pm', w).entryTime).toBe('22:30');
    const win = { rule: { ...base(), entry: { kind: 'window', from: '22:30', to: '01:30', conditions: [] } }, lots: 5, when: 'later' };
    expect(W.parseAnswer('time', '22:30 to 01:30', win).window).toEqual({ from: '22:30', to: '01:30' });
    expect(W.parseAnswer('time', '22:30', win).window).toEqual({ from: '22:30', to: '01:30' }); // a single time opens a 3 hour window
    expect(W.parseAnswer('time', 'whenever', w).ok).toBe(false);
  });
  it('every condition you listed can be said in words', () => {
    const id = (t: string) => W.parseAnswer('conditions', t, w).id;
    expect(id('ADX below and falling')).toBe('adx_falling');
    expect(id('adix below 20 and falling')).toBe('adx_falling');
    expect(W.parseAnswer('conditions', 'adix below 20 and falling', w).cond.value).toBe(20);
    expect(id('atm iv falling')).toBe('atmiv_falling');
    expect(id('dvol falling')).toBe('dvol_falling');
    expect(id('rsi falling')).toBe('rsi_falling');
    expect(id('rv falling')).toBe('rv_falling');
    expect(id('tonight iv vs clock')).toBe('ivclock');
    expect(W.parseAnswer('conditions', 'iv below clock', w).cond.op).toBe('below');
    expect(id('edge between 2 and 6')).toBe('edge');
    expect(W.parseAnswer('conditions', 'edge between 6 and 2', w).cond).toMatchObject({ low: 2, high: 6 });
    expect(W.parseAnswer('conditions', 'atm iv falling 45 min', w).cond.minutes).toBe(45);
    expect(W.parseAnswer('conditions', 'done', w).done).toBe(true);
    expect(W.parseAnswer('conditions', 'purple', w).ok).toBe(false);
  });
  it('days', () => {
    expect(W.parseAnswer('days', 'every day', w).days).toHaveLength(7);
    expect(W.parseAnswer('days', 'weekdays', w).days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(W.parseAnswer('days', 'mon tue fri', w).days).toEqual(['mon', 'tue', 'fri']);
    expect(W.parseAnswer('days', 'monday to wednesday', w).days).toEqual(['mon', 'tue', 'wed']);
    expect(W.parseAnswer('days', 'whenever', w).ok).toBe(false);
  });
  it('stops, exit time, lots, mode and the final action', () => {
    expect(W.parseAnswer('stops', '3x', w).patch.stopMultiple).toBe(3);
    expect(W.parseAnswer('stops', 'none', w).patch.stopMultiple).toBeNull();
    expect(W.parseAnswer('stops', 'target $40', w).patch.netTarget).toBe(40);
    const fut = { rule: P.applyPatch(base(), { legs: 'future', side: 'long' }), lots: 50, when: 'now' };
    expect(W.parseAnswer('stops', 'stop $25 target $50', fut).patch).toMatchObject({ stopUsd: 25, netTarget: 50 });
    expect(W.parseAnswer('exittime', '07:00', w).exitTime).toBe('07:00');
    expect(W.parseAnswer('exittime', 'none', w).exitTime).toBeNull();
    expect(W.parseAnswer('lots', '75', w).lots).toBe(75);
    expect(W.parseAnswer('lots', 'many', w).ok).toBe(false);
    expect(W.parseAnswer('mode', 'live', w).mode).toBe('live');
    expect(W.parseAnswer('review', 'save and arm', w).act).toBe('arm');
    expect(W.parseAnswer('review', 'save', w).act).toBe('save');
    expect(W.parseAnswer('review', 'place now', w).act).toBe('now');
  });
});

describe('filling the form step by step', () => {
  const run = (w: any, answers: Array<[string, string]>) => {
    const flashed: string[][] = [];
    for (const [step, text] of answers) {
      const a = W.parseAnswer(step, text, w);
      expect(a.ok, `${step}: ${text}`).toBe(true);
      flashed.push(W.applyAnswer(w, step, a));
    }
    return flashed;
  };
  it('a scheduled option strangle with every falling condition ends as a rule the server accepts', () => {
    const w = fresh('later', 50);
    const f = run(w, [['kind', 'strangle'], ['delta', '0.10'], ['expiry', '1dte'], ['when', 'schedule'], ['entry', 'window'], ['time', '22:30 to 01:30'],
      ['conditions', 'adx falling'], ['conditions', 'atm iv falling'], ['conditions', 'dvol falling'], ['conditions', 'rsi falling'], ['conditions', 'rv falling'], ['conditions', 'iv vs clock'], ['conditions', 'edge between 1 and 6'],
      ['days', 'mon tue fri'], ['stops', '2x'], ['exittime', '07:00'], ['lots', '25'], ['mode', 'paper']]);
    expect(ok(w.rule).success).toBe(true);
    expect(w.rule.legs).toHaveLength(2);
    expect(w.rule.expiry).toEqual({ mode: 'next' });
    expect(w.rule.entry).toMatchObject({ kind: 'window', from: '22:30', to: '01:30' });
    expect(w.rule.entry.conditions.map((c: any) => c.type)).toEqual(['adx_falling', 'atmiv_falling', 'dvol_falling', 'rsi_falling', 'rv_falling', 'ivclock', 'edge']);
    expect(w.rule.entry.conditions[6]).toMatchObject({ low: 1, high: 6 });
    expect(w.rule.days).toEqual(['mon', 'tue', 'fri']);
    expect(w.rule.exit.exitTime).toBe('07:00');
    expect(w.lots).toBe(25);
    // every answer says which boxes to flash
    expect(f[0]).toContain('legs.0.pick.target');
    expect(f[2]).toEqual(['expiry.mode']);
    expect(f[6]).toEqual(['entry.conditions.0.*']);
    expect(f[7]).toEqual(['entry.conditions.1.*']);
    expect(f[13]).toEqual(['days.mon', 'days.tue', 'days.fri']);
  });
  it('adding the same condition again replaces it instead of doubling it', () => {
    const w = fresh('later'); run(w, [['entry', 'window'], ['conditions', 'edge between 1 and 4'], ['conditions', 'edge between 2 and 9']]);
    expect(w.rule.entry.conditions).toHaveLength(1);
    expect(w.rule.entry.conditions[0]).toMatchObject({ low: 2, high: 9 });
  });
  it('a futures trade right now ends with dollar stop and target', () => {
    const w = fresh('now', 20);
    run(w, [['kind', 'future long'], ['when', 'now'], ['stops', 'stop $25 target $50'], ['exittime', 'none'], ['lots', '20']]);
    expect(ok(w.rule).success).toBe(true);
    expect(w.rule.instrument).toBe('future');
    expect(w.rule.legs).toEqual([]);
    expect(w.rule.exit).toMatchObject({ futStopUsd: 25, futTargetUsd: 50, legStopMultiple: null });
  });
  it('going back from a future to an option restores the per-leg stop', () => {
    const w = fresh('now'); run(w, [['kind', 'future long'], ['kind', 'strangle']]);
    expect(w.rule.instrument).toBe('option');
    expect(w.rule.exit.legStopMultiple).toBe(2);
    expect(w.rule.exit.futStopUsd).toBeNull();
    expect(ok(w.rule).success).toBe(true);
  });
  it('no stop on a futures trade clears both dollar limits', () => {
    const w = fresh('now'); run(w, [['kind', 'future short'], ['stops', 'stop $20 target $30'], ['stops', 'none']]);
    expect(w.rule.exit.futStopUsd).toBeNull();
    expect(w.rule.exit.futTargetUsd).toBeNull();
  });
  it('the one-line summary follows the answers', () => {
    const w = fresh('later', 50); run(w, [['entry', 'hard'], ['time', '22:30']]);
    expect(W.summary(w)).toBe('sell call + sell put · nearest delta 0.1 · 0DTE · 50 lots · at 22:30 IST');
  });
});

describe('recommendations', () => {
  const stats = (n: number, total: number, winRate: number) => ({ n, total, winRate, wins: Math.round(n * winRate) });
  it('kind: names the best recorded strategy and its slot, or says there is none', () => {
    const r = W.recKind({ best: { label: 'New York short strangle', key: 'NY_SHORT', stats: stats(20, 129.5, 0.7) }, futTop: { label: 'MACD sign', winRate: 0.54, now: 1 } });
    expect(r[0]).toContain('New York short strangle');
    expect(r[0]).toContain('22:30 IST');
    expect(r[1]).toMatch(/MACD sign.*buy/);
    expect(W.recKind({ best: null, futTop: null })[0]).toMatch(/No strategy has 5 recorded trades/);
  });
  it('time: the best slot', () => {
    expect(W.recTime({ best: { label: 'Asia short strangle', key: 'ASIA_SHORT', stats: stats(10, 40, 0.6) } })[0]).toContain('10:00 IST');
    expect(W.recTime({ best: null })[0]).toMatch(/22:30 IST \(New York\)/);
  });
  it('days: lists good and bad days and offers the good ones as one choice', () => {
    const d = (name: string, short: string, n: number, total: number, wins: number, kind: string) => ({ name, short, kind, stats: { n, total, wins } });
    const r = W.recDays({ label: 'NY', days: [d('Monday', 'Mon', 8, 40, 7, 'good'), d('Tuesday', 'Tue', 8, -30, 2, 'bad'), d('Friday', 'Fri', 6, 25, 5, 'good')] });
    expect(r.text[0]).toMatch(/Monday .*Friday/);
    expect(r.text[1]).toMatch(/Tuesday/);
    expect(r.chips[0].v).toBe('mon fri');
    expect(W.recDays({ label: 'NY', days: [d('Monday', 'Mon', 1, 5, 1, 'few')] }).chips).toEqual([]);
  });
  it('conditions: shows each live check with a tick or a cross', () => {
    expect(W.recConditions([{ label: 'DVOL falling', ok: true, now: 'DVOL 51' }, { label: 'RV falling', ok: false, now: 'RV 40' }])).toEqual(['✓ DVOL falling · DVOL 51', '✗ RV falling · RV 40']);
  });
  it('stops and lots', () => {
    expect(W.recStops({ rule: { instrument: 'future' } }, { recommend: { suggest: { stopUsd: 25, targetUsd: 50 } } })[0]).toMatch(/stop \$25 and target \$50/);
    expect(W.recStops({ rule: { instrument: 'option' } }, null)[0]).toMatch(/2x/);
    expect(W.recLots({ margin: { required: 86.2, note: 'estimate' } })[0]).toContain('$86.20');
  });
});

describe('starting the wizard', () => {
  it('"algo trading" and its variants start it; questions about it do not', () => {
    for (const q of ['algo trading', 'Algo', 'open algo trading', 'create algo strategy', 'start algo trading', 'algo form']) expect(W.isStart(q), q).toBe(true);
    for (const q of ['what is algo trading', 'how does algo work', 'explain algo trading', 'entry 50', 'best indicator for algo trading']) expect(W.isStart(q), q).toBe(false);
  });
});
