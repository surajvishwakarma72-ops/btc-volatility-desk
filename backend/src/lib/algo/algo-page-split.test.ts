import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Algo page shows Live money and Paper money apart. The code is in frontend/index.html; these tests run that exact code on sample runs
 * to prove the numbers of the two are never added together and each view shows only what it should.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../../frontend/index.html'), 'utf8');
const ha = html.indexOf('  function heroHtml() {'), hb = html.indexOf('  function skeleton() {', ha);
const ra = html.indexOf('  function runsHtml() {'), rb = html.indexOf('\n  function ', ra + 10);
if (ha < 0 || hb < ha || ra < 0 || rb < ra) throw new Error('heroHtml / runsHtml not found in frontend/index.html');

const usd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const stubs = {
  usd, sgn: (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : ''), esc: (x: unknown) => String(x ?? ''), IST: () => '12:00',
  dkUi: { kpi: (label: string, value: string, _cls: string, sub: string) => `[${label}=${value}|${sub}]`, bars: () => '[bars]' },
};
function pageFns(S: Record<string, unknown>) {
  return new Function('S', 'usd', 'sgn', 'esc', 'IST', 'dkUi', `${html.slice(ha, hb)}\n${html.slice(ra, rb)}\nreturn { heroHtml, runsHtml };`)(S, stubs.usd, stubs.sgn, stubs.esc, stubs.IST, stubs.dkUi) as { heroHtml(): string; runsHtml(): string };
}

const now = Date.now();
const run = (id: string, name: string, mode: 'live' | 'paper', status: string, over: Record<string, unknown> = {}) => ({ id, name, mode, status, enteredAt: now - 3_600_000, windowStart: now - 3_600_000, exitedAt: status === 'exited' ? now - 60_000 : null, lots: 5, netPnl: null, liveNetPnl: null, plan: null, reason: '', exitReason: '', ...over });
const st = {
  strategies: [{ rule: { mode: 'live' }, armed: true }, { rule: { mode: 'paper' }, armed: false }, { rule: { mode: 'paper' }, armed: true }],
  runs: [
    run('l1', 'Live night strangle', 'live', 'exited', { netPnl: 20 }),
    run('l2', 'Live day strangle', 'live', 'entered', { liveNetPnl: 3 }),
    run('p1', 'Practice strangle', 'paper', 'exited', { netPnl: 1000 }),
    run('p2', 'Practice second', 'paper', 'exited', { netPnl: -10 }),
  ],
};
const state = (mv: string) => ({ mv, st, sel: null });

describe('the Algo page keeps Live and Paper apart', () => {
  it("side by side: one strip for LIVE and one for PAPER, each with its own numbers, never added together", () => {
    const h = pageFns(state('all')).heroHtml();
    const live = h.indexOf('al-chip live'), paper = h.indexOf('al-chip paper');
    expect(live).toBeGreaterThan(-1);
    expect(paper).toBeGreaterThan(live); // live money is shown first
    const liveStrip = h.slice(live, paper), paperStrip = h.slice(paper);
    expect(liveStrip).toContain('[Today=$23.00|'); // 20 closed + 3 open
    expect(liveStrip).toContain('[Open now=1|net $3.00]');
    expect(liveStrip).toContain('[Armed=1 of 1|');
    expect(paperStrip).toContain('[Today=$990.00|'); // 1000 - 10, none of the live money in it
    expect(paperStrip).toContain('[Open now=0|no position]');
    expect(paperStrip).toContain('[Armed=1 of 2|');
    expect(h).not.toContain('$1013.00');
    expect(h).not.toContain('$1013');
  });

  it("'Live only' shows only the live strip, 'Paper only' only the paper one", () => {
    const l = pageFns(state('live')).heroHtml(), p = pageFns(state('paper')).heroHtml();
    expect(l).toContain('al-chip live'); expect(l).not.toContain('al-chip paper');
    expect(l).toContain('[Today=$23.00|'); expect(l).not.toContain('$990');
    expect(p).toContain('al-chip paper'); expect(p).not.toContain('al-chip live');
    expect(p).toContain('[Today=$990.00|'); expect(p).not.toContain('$23.00');
  });

  it('the switch is there with the three choices, and marks the one in use', () => {
    const h = pageFns(state('live')).heroHtml();
    for (const k of ['all', 'live', 'paper']) expect(h).toContain(`data-al="mv" data-k="${k}"`);
    expect(h).toMatch(/data-k="live" class="on"/);
    expect(h).toMatch(/data-k="all" class=""/);
  });

  it('the runs table shows only the money in view, with a LIVE or PAPER badge on every row', () => {
    const all = pageFns(state('all')).runsHtml(), live = pageFns(state('live')).runsHtml(), paper = pageFns(state('paper')).runsHtml();
    for (const n of ['Live night strangle', 'Live day strangle', 'Practice strangle', 'Practice second']) expect(all).toContain(n);
    expect(all).toContain('al-chip live">LIVE</span>');
    expect(all).toContain('al-chip paper">PAPER</span>');
    expect(live).toContain('Live night strangle'); expect(live).not.toContain('Practice'); expect(live).not.toContain('PAPER</span>');
    expect(paper).toContain('Practice strangle'); expect(paper).not.toContain('Live night'); expect(paper).not.toContain('LIVE</span>');
  });

  it('says which kind has no runs yet instead of an empty table', () => {
    const none = { mv: 'live', sel: null, st: { strategies: [], runs: [run('p1', 'Practice strangle', 'paper', 'exited', { netPnl: 5 })] } };
    expect(pageFns(none).runsHtml()).toContain('No Live runs yet.');
  });
});
