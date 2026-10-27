import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStrangle, strategySchema } from '../algo/rule.js';

/**
 * Ask me's trading commands live in frontend/index.html; their pure core sits between ASKTRADE-CORE markers.
 * These tests run that exact code and check every rule it writes against the server's own schema.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// ASKTRADE-CORE-START'), b = html.indexOf('// ASKTRADE-CORE-END');
if (a < 0 || b < 0) throw new Error('ASKTRADE markers not found in frontend/index.html');
const T = new Function(`${html.slice(a, b)}\nreturn { parseTrade, parsePatch, applyPatch, congrats, defaultExitTime, parseCapital, lotsForCapital };`)() as {
  parseTrade(q: string, pending?: string | null): { kind: string; lots?: number; patch?: any; which?: string } | null;
  parsePatch(q: string): any;
  defaultExitTime(hhmm: string): string;
  parseCapital(q: string): number | null;
  lotsForCapital(inr: number): number;
  applyPatch(rule: any, p: any): any;
  congrats(rule: any, lots: number, pv: any, res: any, when: string): { head: string; rows: string[][]; lines: string[] };
};
const base = () => JSON.parse(JSON.stringify(defaultStrangle()));
const valid = (r: unknown) => strategySchema.safeParse(r).success;

describe('exit asks Paper or Live', () => {
  it('plain "exit" still opens the question', () => {
    for (const q of ['exit', 'Exit all', 'kill all', 'close all positions', 'square off']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'exit' });
  });
  it('"exit live" and "exit paper" answer it straight away', () => {
    for (const q of ['exit live', 'Exit live', 'kill all live', 'close all positions live', 'exit real', 'please exit delta']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'exitpick', mode: 'live' });
    for (const q of ['exit paper', 'Exit Paper', 'close all paper']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'exitpick', mode: 'paper' });
  });
  it('once asked, a one-word answer picks the side', () => {
    for (const q of ['live', 'Live', 'real', 'delta']) expect(T.parseTrade(q, 'exit'), q).toMatchObject({ kind: 'exitpick', mode: 'live' });
    for (const q of ['paper', 'Paper', 'test']) expect(T.parseTrade(q, 'exit'), q).toMatchObject({ kind: 'exitpick', mode: 'paper' });
  });
  it('a bare "live" with no question open does not exit anything', () => {
    expect(T.parseTrade('live')?.kind).not.toBe('exitpick');
  });
});

describe('trade commands', () => {
  it('"entry 50" means 50 lots', () => {
    for (const q of ['entry 50', 'Entry 50', 'enter 50 lots', 'sell 50', 'please entry 50.']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'entry', lots: 50 });
    expect(T.parseTrade('entry 5 delta 0.08 expiry current stop 3x')).toMatchObject({ kind: 'entry', lots: 5, patch: { deltaTarget: 0.08, expiry: { mode: 'current' }, stopMultiple: 3 } });
  });
  it('"exit" is a kill, but only as a command on its own', () => {
    for (const q of ['exit', 'Exit all', 'kill all', 'hard exit', 'close all positions', 'square off']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'exit' });
    expect(T.parseTrade('why was the last trade an exit')).toBeNull();
    expect(T.parseTrade('what is the exit rule for the NY short')).toBeNull();
  });
  it('ok and cancel only count while something is waiting', () => {
    expect(T.parseTrade('ok', null)).toBeNull();
    expect(T.parseTrade('ok', 'summary')).toMatchObject({ kind: 'ok' });
    expect(T.parseTrade('ok return', 'builder')).toMatchObject({ kind: 'ok' });
    expect(T.parseTrade('cancel', 'builder')).toMatchObject({ kind: 'cancel' });
    expect(T.parseTrade('no', null)).toBeNull();
  });
  it('a change while a card is waiting is a patch; a normal question is not', () => {
    expect(T.parseTrade('delta 0.08', 'summary')).toMatchObject({ kind: 'patch', patch: { deltaTarget: 0.08 } });
    expect(T.parseTrade('how does the bot work', 'summary')).toBeNull();
    expect(T.parseTrade('exit 07:00', 'builder')).toMatchObject({ kind: 'patch', patch: { exitTime: '07:00' } });
  });
  it('saves defaults with "set default"', () => {
    expect(T.parseTrade('set default delta 0.10, expiry 1dte, stop 2x, entry 22:30, exit 07:00, days mon tue wed'))
      .toMatchObject({ kind: 'default', patch: { deltaTarget: 0.1, expiry: { mode: 'next' }, stopMultiple: 2, entryTime: '22:30', exitTime: '07:00', days: ['mon', 'tue', 'wed'] } });
    expect(T.parseTrade('show my default')).toMatchObject({ kind: 'showdefault' });
  });
});

describe('expiry words', () => {
  it('0dte is current, 1dte is next, 2dte and next to next are n2n', () => {
    expect(T.parsePatch('0dte').expiry).toEqual({ mode: 'current' });
    expect(T.parsePatch('expiry 1dte').expiry).toEqual({ mode: 'next' });
    expect(T.parsePatch('2 dte').expiry).toEqual({ mode: 'n2n' });
    expect(T.parsePatch('expiry next to next').expiry).toEqual({ mode: 'n2n' });
    expect(T.parsePatch('next expiry').expiry).toEqual({ mode: 'next' });
  });
});

describe('the default is one two-leg strangle on the next-to-next (2DTE) expiry', () => {
  it('applying nothing keeps 2 legs, delta 0.10, 2DTE expiry', () => {
    const r = T.applyPatch(base(), {});
    expect(r.legs).toHaveLength(2);
    expect(r.legs.map((l: any) => l.pick)).toEqual([{ mode: 'delta', target: 0.1 }, { mode: 'delta', target: 0.1 }]);
    expect(r.expiry).toEqual({ mode: 'n2n' });
  });
});

describe('option or future?', () => {
  it('"entry 50" alone does not say, so Ask me asks', () => {
    expect(T.parseTrade('entry 50')!.patch.legs).toBeUndefined();
    expect(T.parseTrade('entry 50 future long')!.patch).toMatchObject({ legs: 'future', side: 'long' });
    expect(T.parseTrade('entry 10 option')!.patch).toMatchObject({ legs: 'strangle' });
  });
  it('the answer can be typed in several ways', () => {
    for (const [q, want] of [['option', { legs: 'strangle' }], ['strangle', { legs: 'strangle' }], ['future', { legs: 'future', side: 'long' }], ['future short', { legs: 'future', side: 'short' }], ['sell', { legs: 'future', side: 'short' }], ['long', { legs: 'future', side: 'long' }]] as const) {
      expect(T.parseTrade(q, 'choose'), q).toMatchObject({ kind: 'choice', patch: want });
    }
    expect(T.parseTrade('banana', 'choose')).toBeNull();
    expect(T.parseTrade('cancel', 'choose')).toMatchObject({ kind: 'cancel' });
  });
});

describe('capital in rupees and the lot size it suggests', () => {
  it('reads an amount in the ways people write it', () => {
    for (const [q, v] of [['10000', 10000], ['10,000', 10000], ['10k', 10000], ['₹5k', 5000], ['rs 5000', 5000], ['2 lakh', 200000], ['1.5k', 1500], ['inr 25,000', 25000], ['50 thousand', 50000]] as const) expect(T.parseCapital(q), q).toBe(v);
  });
  it('anything that is not an amount is not an amount', () => {
    for (const q of ['', 'lots', 'abc', '12', 'five thousand', '10k lots']) expect(T.parseCapital(q), q).toBeNull();
  });
  it('100 rupees of capital per lot: 10,000 gives 100 lots, 5,000 gives 50', () => {
    expect(T.lotsForCapital(10000)).toBe(100);
    expect(T.lotsForCapital(5000)).toBe(50);
    expect(T.lotsForCapital(1500)).toBe(15);
    expect(T.lotsForCapital(100)).toBe(1);
    expect(T.lotsForCapital(40)).toBe(1);
  });
});

describe('the guided entry questions', () => {
  it('"entry" on its own starts them, with nothing guessed', () => {
    for (const q of ['entry', 'Entry', 'enter', 'new trade', 'place a trade']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'entry', lots: null, patch: {} });
    expect(T.parseTrade('entry option now')).toMatchObject({ kind: 'entry', lots: null, patch: { legs: 'strangle', when: 'now' } });
    expect(T.parseTrade('entry live')!.patch).toMatchObject({ mode: 'live' });
    expect(T.parseTrade('entry paper future long')!.patch).toMatchObject({ mode: 'paper', legs: 'future', side: 'long' });
  });
  it('"entry 50" still means 50 lots and skips the capital question', () => {
    expect(T.parseTrade('entry 50')).toMatchObject({ kind: 'entry', lots: 50 });
  });
  it('the capital answer, the lots answer and the paper or live answer are read only at their own step', () => {
    expect(T.parseTrade('10k', 'capital')).toMatchObject({ kind: 'capital', inr: 10000 });
    expect(T.parseTrade('10k', 'lots')).toBeNull();
    expect(T.parseTrade('100', 'lots')).toMatchObject({ kind: 'lotspick', lots: 100 });
    expect(T.parseTrade('100 lots', 'lots')).toMatchObject({ kind: 'lotspick', lots: 100 });
    expect(T.parseTrade('live', 'mode')).toMatchObject({ kind: 'modepick', mode: 'live' });
    expect(T.parseTrade('paper', 'mode')).toMatchObject({ kind: 'modepick', mode: 'paper' });
    expect(T.parseTrade('paper', null)).toBeNull();
    expect(T.parseTrade('cancel', 'capital')).toMatchObject({ kind: 'cancel' });
  });
});

describe('the exit time to start from', () => {
  it('a daytime trade closes at 16:00 IST, a night trade at 07:00 IST', () => {
    for (const t of ['05:00', '10:00', '12:30', '15:59']) expect(T.defaultExitTime(t), t).toBe('16:00');
    for (const t of ['16:00', '17:30', '22:30', '23:59', '00:10', '03:00', '04:59']) expect(T.defaultExitTime(t), t).toBe('07:00');
  });
  it('anything unreadable falls back to the night default', () => {
    expect(T.defaultExitTime('')).toBe('07:00');
  });
});

describe('trade now or schedule', () => {
  it('the answer can be typed, or already be in the sentence', () => {
    expect(T.parseTrade('now', 'when')).toMatchObject({ kind: 'when', patch: { when: 'now' } });
    expect(T.parseTrade('schedule', 'when')).toMatchObject({ kind: 'when', patch: { when: 'later' } });
    expect(T.parseTrade('at 22:30 tonight', 'when')).toMatchObject({ kind: 'when', patch: { when: 'later', entryTime: '22:30' } });
    expect(T.parseTrade('banana', 'when')).toBeNull();
    expect(T.parseTrade('entry 50 future long now')!.patch).toMatchObject({ legs: 'future', when: 'now' });
    expect(T.parseTrade('entry 50 option schedule')!.patch).toMatchObject({ legs: 'strangle', when: 'later' });
    expect(T.parseTrade('entry 50')!.patch.when).toBeUndefined();
  });
});

describe('dollar stops and targets', () => {
  it('a futures rule takes stop and target in dollars', () => {
    expect(T.parsePatch('stop $20 target $40')).toMatchObject({ stopUsd: 20, netTarget: 40 });
    expect(T.parsePatch('stop loss 15 dollars')).toMatchObject({ stopUsd: 15 });
    const r = T.applyPatch(base(), T.parsePatch('future long stop $25 target $50'));
    expect(r.instrument).toBe('future');
    expect(r.exit.futStopUsd).toBe(25);
    expect(r.exit.futTargetUsd).toBe(50);
    expect(r.exit.futStopPct).toBeNull();
    expect(valid(r)).toBe(true);
  });
  it('the same words on an option strangle set the net stop and target', () => {
    const r = T.applyPatch(base(), T.parsePatch('stop $30 target $40'));
    expect(r.exit.netStopUsd).toBe(30);
    expect(r.exit.netTargetUsd).toBe(40);
    expect(r.exit.futStopUsd ?? null).toBeNull();
    expect(valid(r)).toBe(true);
  });
  it('"stop 3x" is still a multiple', () => {
    expect(T.parsePatch('stop 3x')).toMatchObject({ stopMultiple: 3 });
    expect(T.parsePatch('stop 3x').stopUsd).toBeUndefined();
  });
  it('the read-back says dollars', () => {
    const r = T.applyPatch(base(), T.parsePatch('future short stop $25 target $50'));
    const c = T.congrats(r, 50, { expiries: [], lines: [] }, { detail: 'x' }, 'now');
    expect(Object.fromEntries(c.rows.map(([k, v]) => [k, v]))['Stoploss']).toBe('$25 stop, $50 target');
  });
});

describe('day wise pnl questions', () => {
  it('open the strategy and weekday scoreboard in the chat', () => {
    for (const q of ['day wise pnl', 'show me day wise pnl', 'pnl by day', 'strategy wise pnl', 'which day is good for profit', 'weekday wise performance']) expect(T.parseTrade(q), q).toMatchObject({ kind: 'dayscore' });
    expect(T.parseTrade('score')).toMatchObject({ kind: 'dayscore' });
    expect(T.parseTrade('open the score page')).toMatchObject({ kind: 'dayscore' });
  });
  it('plain talk about days or pnl is not taken', () => {
    expect(T.parseTrade('how did monday do in the backtest')).toBeNull();
    expect(T.parseTrade('what is the pnl')).toBeNull();
    expect(T.parseTrade("today's pnl")).toBeNull();
  });
});

describe('asking for the best indicator', () => {
  it('needs both an indicator word and futures / options', () => {
    expect(T.parseTrade('best indicator for futures')).toMatchObject({ kind: 'insight', which: 'future' });
    expect(T.parseTrade('which indicators work for option selling')).toMatchObject({ kind: 'insight', which: 'option' });
    expect(T.parseTrade('suggest the best indicator for algo trading')).toMatchObject({ kind: 'insight', which: 'both' });
    expect(T.parseTrade('what is the most important indicator')).toBeNull();
    expect(T.parseTrade('what is rsi')).toBeNull();
  });
});

describe('patches', () => {
  it('times, windows and days', () => {
    expect(T.parsePatch('entry at 10:30 pm')).toMatchObject({ entryTime: '22:30' });
    expect(T.parsePatch('between 10:30pm and 1:30am')).toMatchObject({ window: { from: '22:30', to: '01:30' } });
    expect(T.parsePatch('days monday to friday')).toMatchObject({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    expect(T.parsePatch('only friday')).toMatchObject({ days: ['fri'] });
    expect(T.parsePatch('weekdays')).toMatchObject({ days: ['mon', 'tue', 'wed', 'thu', 'fri'] });
    expect(T.parsePatch('every day').days).toHaveLength(7);
    expect(T.parsePatch('friday to monday').days).toEqual(['fri', 'sat', 'sun', 'mon']);
  });
  it('stops, targets, mode and structure', () => {
    expect(T.parsePatch('no stop')).toMatchObject({ stopMultiple: null });
    expect(T.parsePatch('stoploss 2.5x')).toMatchObject({ stopMultiple: 2.5 });
    expect(T.parsePatch('net target $40 net stop 60')).toMatchObject({ netTarget: 40, netStop: 60 });
    expect(T.parsePatch('mode live')).toMatchObject({ mode: 'live' });
    expect(T.parsePatch('straddle')).toMatchObject({ legs: 'straddle' });
    expect(T.parsePatch('futures short')).toMatchObject({ legs: 'future', side: 'short' });
  });
  it('mentions nothing, changes nothing', () => {
    expect(T.parsePatch('hello there')).toEqual({});
  });
  it('every rule it writes passes the server schema', () => {
    const phrases = ['', 'delta 0.05', 'delta 0.05-0.08', 'expiry current', '0dte', 'expiry next', '1dte', '2dte', 'next to next', 'b2b', 'expiry 261027', 'stop 3x', 'no stop', 'straddle', 'call only', 'put only', 'futures long', 'futures short',
      'between 22:30 and 01:30', 'entry 10:00', 'exit 07:00', 'days mon tue', 'mode live', 'net target 30 net stop 50', 'straddle stop 3x exit 05:00 days friday'];
    for (const ph of phrases) {
      const r = T.applyPatch(base(), T.parsePatch(ph));
      const res = strategySchema.safeParse(r);
      expect(res.success, `${ph}: ${res.success ? '' : JSON.stringify(res.error.issues)}`).toBe(true);
    }
  });
  it('applyPatch does not touch the original', () => {
    const r = base();
    T.applyPatch(r, T.parsePatch('delta 0.05-0.08 stop 4x days fri'));
    expect(valid(r)).toBe(true);
    expect(r.exit.legStopMultiple).toBe(2);
    expect(r.days).toHaveLength(7);
  });
  it('a delta change reaches both legs, and a straddle drops the delta', () => {
    const r = T.applyPatch(base(), T.parsePatch('delta 0.08'));
    expect(r.legs.map((l: any) => l.pick.target)).toEqual([0.08, 0.08]);
    const s = T.applyPatch(base(), T.parsePatch('straddle'));
    expect(s.legs.map((l: any) => l.pick.mode)).toEqual(['atm', 'atm']);
  });
  it('a window keeps its conditions when only the times change', () => {
    const r = base();
    r.entry = { kind: 'window', from: '10:00', to: '11:00', conditions: [{ type: 'gate' }] };
    const n = T.applyPatch(r, T.parsePatch('between 22:30 and 01:30'));
    expect(n.entry.conditions).toEqual([{ type: 'gate' }]);
    expect(valid(n)).toBe(true);
  });
});

describe('the reply after an order', () => {
  it('says congratulations, with expiry, entry, exit, stoploss and why', () => {
    const r = base();
    r.exit.exitTime = '07:00';
    const c = T.congrats(r, 50, { expiries: ['271026', '281026'], lines: ['Sell 50 x 105000 Call'] }, { detail: '4 legs' }, 'now');
    expect(c.head).toMatch(/^Congratulations, order placed with stoploss/);
    const m = Object.fromEntries(c.rows.map(([k, v]) => [k, v]));
    expect(m['Expiry']).toBe('271026 + 281026');
    expect(m['Exit']).toContain('07:00');
    expect(m['Stoploss']).toContain('2x');
    expect(m['Why enter']).toBeTruthy();
    expect(c.lines).toHaveLength(1);
  });
  it('a dry run is never called a placed order', () => {
    const c = T.congrats(base(), 5, { expiries: ['271026'], lines: [] }, { dry: true, detail: 'DRY RUN' }, 'now');
    expect(c.head).toMatch(/Dry run/);
    expect(c.head).not.toMatch(/Congratulations/);
  });
});
