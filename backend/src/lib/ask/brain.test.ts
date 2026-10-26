import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Ask brain lives in frontend/index.html (it draws from numbers already loaded in the page). Its pure core sits between
 * ASKBRAIN-CORE markers, so these tests run that exact code: what it understands, what it draws, and that it never invents numbers.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// ASKBRAIN-CORE-START'), b = html.indexOf('// ASKBRAIN-CORE-END');
if (a < 0 || b < 0) throw new Error('ASKBRAIN markers not found in frontend/index.html');
const core = html.slice(a, b);
const B = new Function(`${core}\nreturn { understand, answer, suggest, render, PHRASES, GUIDES, norm };`)() as {
  understand(q: string): { id: string | null; guide?: string; slots: { day?: number; iv?: number } };
  answer(q: string, D: any): Promise<{ title: string; blocks: any[]; follow?: string[] } | null>;
  suggest(t: string, n?: number): string[];
  render(a: any): string;
  PHRASES: string[];
  GUIDES: Record<string, any>;
  norm(q: string): string;
};

const decideWait = { w: 'WAIT', c: 'n', why: ['Sun night: no new entry'], checks: [['Weekday · Mon–Fri', false, 'Weekend'], ['Speed Beacon', true, '—'], ['Timing Window', false, 'Before NY Window'], ['News', true, 'clear']] };
const decideGo = { w: 'GO', c: 'g', why: ['all checks agree'], checks: [['Weekday', true, 'Tue'], ['Speed Beacon', true, '—'], ['Entry Gauge: GO', true, '30']] };
const byWd = [
  { wd: 1, name: 'Mon', n: 291, stop: 27.5, avgMove: 2.1, big09: 80.8, red: 56.4, green: 16.5 },
  { wd: 2, name: 'Tue', n: 290, stop: 26.5, avgMove: 2.0, big09: 78, red: 50, green: 20 },
  { wd: 3, name: 'Wed', n: 287, stop: 32.2, avgMove: 2.3, big09: 82, red: 58, green: 15 },
  { wd: 5, name: 'Fri', n: 285, stop: 17.5, avgMove: 1.6, big09: 70, red: 40, green: 28 },
];
const strategies = [
  { name: 'A. always sell at 22:30 IST', nights: 994, trades: 994, win: 71.5, stop: 26, avg: 4.5, total: 4437, worst: -104 },
  { name: 'C. Risk-ADX ≤ 25 at 22:30', nights: 994, trades: 737, win: 76.3, stop: 21, avg: 6.4, total: 4688, worst: -73 },
  { name: 'H. first hour with Risk-ADX ≤ 25', nights: 994, trades: 800, win: 78.7, stop: 19, avg: 6.8, total: 5300, worst: -101 },
];
const sessions = Array.from({ length: 60 }, (_, i) => ({ day: '2025-01-' + i, dow: 1 + (i % 5), iv: 32 + (i % 3), baselineAction: 'TRADE', stoppedAt2x: i % 12 === 0, baselinePnl: i % 12 === 0 ? -80 : 110, cr: 360 }));
const D = {
  decide: decideWait, verdict: { L: 55, color: 'yellow', soft: { spd: 0, model: 0.3, fear: 0.6, rise: 0, vov: 0, rv: 0, edge: 0, adx: 0.1 } },
  daily: { byWd, byColor: [{ color: 'green', stop: 13.9 }, { color: 'yellow', stop: 18.1 }, { color: 'red', stop: 29.6 }] },
  risk: { names: { spd: 'IV vs speed', atm: 'ATM IV', edge: 'Edge' }, coef: { w: { spd: 16, atm: 8, edge: -3 } }, gauge: { weights: { spd: 16, model: 8 } }, strategies, samples: 5827 },
  shadow: { sessions, aggregates: { baseline: { trades: 322, winRate: '93.8%', stops: 20 } } },
  iv: 33,
};

describe('Ask brain: understanding the question', () => {
  const cases: Array<[string, string]> = [
    ['Should I trade tonight?', 'trade_now'], ['can i sell today', 'trade_now'], ['go or wait?', 'trade_now'], ['give me the verdict', 'trade_now'],
    ['shuld i trad tonite', 'trade_now'], ['should i trade on monday', 'trade_now'],
    ['what is the most important indicator', 'indicators'], ['which indicators matter most', 'indicators'], ['show indicator weightage', 'indicators'],
    ['top performer', 'top_performer'], ['wats the top perfomer', 'top_performer'], ['which strategy is best', 'top_performer'], ['show the leaderboard', 'top_performer'],
    ['backtested data of monday', 'weekday'], ['how did Tuesday do in the backtest', 'weekday'], ['which night is safest', 'weekday'], ['fridays stats', 'weekday'],
    ['is iv enough to trade', 'iv_enough'], ['is IV 32 enough', 'iv_enough'], ['is the credit enough', 'iv_enough'], ['which iv band works best', 'iv_enough'],
    ['is premium selling worth it', 'premium_worth'], ['is premuim selling worth it', 'premium_worth'], ['does selling strangles pay', 'premium_worth'], ['what is the win rate', 'premium_worth'],
    ['how do i set up my delta api key', 'howto_api'], ['api setup', 'howto_api'], ['how do i whitelist the ip', 'howto_whitelist'], ['why is my api key not accepted', 'howto_whitelist'],
    ['how do i invite a friend', 'howto_invite'], ['how do friends create an account', 'howto_invite'], ['how do i paper trade', 'howto_paper'], ['how do i use the strategy builder', 'howto_paper'],
    ['how do i read the entry gauge', 'howto_gauge'], ['what does the dial mean', 'howto_gauge'], ['how does the bot work', 'howto_bot'], ['what is the bot timeline', 'howto_bot'],
    ['how is margin calculated', 'howto_margin'], ['how does the stop loss work', 'howto_stops'], ['how do i trade btc futures on paper', 'howto_futures'],
    ['how does the stop alarm work', 'howto_alarm'], ['what is the hard exit', 'howto_alarm'], ['i want a full screen alarm when the stop is near', 'howto_alarm'], ['will it close the position automatically', 'howto_alarm'],
  ];
  for (const [q, id] of cases) it(`"${q}" is ${id}`, () => expect(B.understand(q).id).toBe(id));

  it('picks up the weekday and the IV number it was asked about', () => {
    expect(B.understand('backtested data of monday').slots.day).toBe(1);
    expect(B.understand('how did fridays do').slots.day).toBe(5);
    expect(B.understand('is iv 28 enough').slots.iv).toBe(28);
  });

  it('leaves questions about live trades, positions and money to the server', () => {
    for (const q of ['Running positions', "Today's PnL", 'Why was the last trade stopped?', 'Why no trade today?', 'This week by strategy', 'Best session', 'Market now', 'What data do you have?', 'What is Risk-ADX?', 'Explain N2N', 'hello']) {
      expect(B.understand(q).id, q).toBeNull();
    }
  });

  it('every suggestion that promises a picture opens one', () => {
    const end = B.PHRASES.indexOf('Running positions');
    for (const p of B.PHRASES.slice(0, end)) expect(B.understand(p).id, p).not.toBeNull();
  });
});

describe('Ask brain: the auto-predictor', () => {
  it('completes partial, misspelt and out-of-order input', () => {
    expect(B.suggest('shuld i tra')[0]).toBe('Should I trade tonight?');
    expect(B.suggest('mond').join('|')).toMatch(/Monday/);
    expect(B.suggest('api')[0]).toMatch(/API/);
    expect(B.suggest('whitel')[0]).toMatch(/whitelist/i);
    expect(B.suggest('top perf')[0]).toBe('What is the top performer?');
    expect(B.suggest('indicator important').join('|')).toMatch(/indicator/i);
  });
  it('is empty for nothing, nonsense, or a finished phrase', () => {
    expect(B.suggest('')).toEqual([]);
    expect(B.suggest('zzzzqq')).toEqual([]);
    expect(B.suggest('Should I trade tonight?')).not.toContain('Should I trade tonight?');
    expect(B.suggest('s', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('Ask brain: the pictures', () => {
  it('should I trade: a WAIT shows the dial, every check, what failed, and a final verdict', async () => {
    const r = (await B.answer('should i trade tonight', D))!;
    const hero = r.blocks.find((x) => x.t === 'hero');
    expect(hero).toMatchObject({ word: 'WAIT', tone: 'wait', dial: 55 });
    const checks = r.blocks.find((x) => x.t === 'checks');
    expect(checks.items).toHaveLength(4);
    expect(checks.items.filter((i: any) => i.ok === false).map((i: any) => i.label)).toEqual(['Weekday · Mon–Fri', 'Timing Window']);
    const note = r.blocks.filter((x) => x.t === 'note').pop();
    expect(note.text).toMatch(/Final verdict: WAIT.*Not met: Weekday · Mon–Fri; Timing Window/);
    expect(r.follow!.length).toBeGreaterThan(0);
  });
  it('should I trade: a GO says GO, in green, and names no failures', async () => {
    const r = (await B.answer('should i trade', { ...D, decide: decideGo }))!;
    expect(r.blocks.find((x) => x.t === 'hero')).toMatchObject({ word: 'GO', tone: 'go' });
    expect(r.blocks.filter((x) => x.t === 'note').pop().text).toMatch(/Final verdict: GO/);
    expect(r.blocks.filter((x) => x.t === 'note').pop().text).not.toMatch(/Not met/);
  });
  it('says it is still loading instead of guessing when the decision is not ready', async () => {
    const r = (await B.answer('should i trade tonight', { ...D, decide: null }))!;
    expect(r.blocks[0].text).toMatch(/still loading/);
  });
  it('indicators: bars ordered by weight, the top three marked, with direction', async () => {
    const r = (await B.answer('most important indicator', D))!;
    const bars = r.blocks.find((x) => x.t === 'bars');
    expect(bars.items.map((i: any) => i.l)).toEqual(['IV vs speed', 'ATM IV', 'Edge']);
    expect(bars.items[2].sub).toBe('lowers stop risk');
    expect(r.blocks.filter((x) => x.t === 'note').pop().text).toMatch(/Most important: IV vs speed, ATM IV, Edge/);
  });
  it('top performer: the best average per night leads, with its own numbers', async () => {
    const r = (await B.answer('top performer', D))!;
    expect(r.blocks.find((x) => x.t === 'hero').word).toMatch(/^first hour with Risk-ADX/);
    const tiles = r.blocks.find((x) => x.t === 'tiles').items;
    expect(tiles[0].v).toBe('$6.8');
    expect(tiles[1].v).toBe('78.7%');
    const live = (await B.answer('top performer', { ...D, live: { name: 'ASIA_SHORT · always', avgPnl: 4.2 } }))!;
    expect(JSON.stringify(live.blocks)).toMatch(/Live paper bot right now: ASIA_SHORT/);
  });
  it('weekday: the asked day is outlined against the average, with its own stats', async () => {
    const r = (await B.answer('backtested data of monday', D))!;
    expect(r.title).toBe('Monday backtest');
    const bars = r.blocks.find((x) => x.t === 'bars');
    expect(bars.items.find((i: any) => i.hi).l).toBe('Mon');
    expect(bars.ref.v).toBeGreaterThan(24);
    expect(bars.ref.v).toBeLessThan(26);
    const tiles = r.blocks.find((x) => x.t === 'tiles').items;
    expect(tiles.find((t: any) => t.k === 'Nights studied').v).toBe(291);
    expect(JSON.stringify(r.blocks)).toMatch(/your 1-year log/); // the 1-year trade log joins in when it has enough Mondays
  });
  it('weekday: a weekend is explained, not invented', async () => {
    const r = (await B.answer('backtest of saturday', D))!;
    expect(r.blocks[0].text).toMatch(/not a trading night/);
  });
  it('IV: puts the asked IV in its band with that band\'s stop rate and credit, and a verdict', async () => {
    const r = (await B.answer('is iv 32 enough', D))!;
    expect(r.blocks.find((x) => x.t === 'hero').word).toBe('IV 32%');
    const bars = r.blocks.filter((x) => x.t === 'bars')[0];
    expect(bars.items.find((i: any) => i.hi).l).toBe('30–35');
    expect(r.blocks.filter((x) => x.t === 'note').pop().text).toMatch(/Final verdict/);
    const noIv = (await B.answer('is iv enough to trade', { ...D, iv: undefined }))!;
    expect(noIv.blocks.find((x) => x.t === 'hero').sub).toMatch(/Tell me an IV/);
  });
  it('premium selling: honest about the win rate, the stops and the worst night', async () => {
    const r = (await B.answer('is premium selling worth it', D))!;
    const text = JSON.stringify(r.blocks);
    expect(text).toMatch(/71\.5%/);
    expect(text).toMatch(/26\.0% of nights a leg was stopped/);
    expect(text).toMatch(/worst night lost \$104/);
    expect(text).toMatch(/only with the filters and the stops/);
  });
  it('guides: every guide has steps, and the gauge guide fills in the real stop rates', async () => {
    for (const k of Object.keys(B.GUIDES)) expect(B.GUIDES[k].steps.length, k).toBeGreaterThanOrEqual(3);
    const r = (await B.answer('how do i read the entry gauge', D))!;
    expect(JSON.stringify(r.blocks)).toMatch(/green 13\.9%, amber 18\.1%, red 29\.6%/);
    const api = (await B.answer('api setup', D))!;
    expect(api.blocks.find((x) => x.t === 'steps').items.length).toBe(7);
    expect(JSON.stringify(api.blocks)).toMatch(/READ permission only/);
  });
  it('returns null for anything it does not know, so the server answers', async () => {
    expect(await B.answer('Running positions', D)).toBeNull();
    expect(await B.answer('', D)).toBeNull();
  });
});

describe('Ask brain: drawing', () => {
  it('turns every block type into HTML and escapes anything that came from data', async () => {
    const r = (await B.answer('should i trade tonight', { ...D, decide: { ...decideWait, checks: [['<img src=x onerror=alert(1)>', false, '<script>x</script>']] } }))!;
    const html = B.render(r);
    expect(html).toContain('abHero');
    expect(html).toContain('abCk');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    for (const q of ['top performer', 'backtest of monday', 'is iv 32 enough', 'is premium selling worth it', 'api setup', 'most important indicator']) {
      const out = B.render((await B.answer(q, D))!);
      expect(out.length, q).toBeGreaterThan(200);
      expect(out, q).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
