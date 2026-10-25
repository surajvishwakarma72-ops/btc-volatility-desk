import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAL_ENTRY_MIN_IST } from './calendar.js';
import { SLOTS, istDateKey, runWindow } from './schedule.js';
import { istDay, sessionBounds } from './sessions.js';

/**
 * The Bot page counts down to the next strategy start in the browser (so it works before login).
 * That schedule table is plain JavaScript inside frontend/index.html; this test pulls it out and
 * checks it against the backend's schedule and session calendar, so the two cannot drift apart.
 */
const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/index.html'), 'utf8');
const src = /\/\/ NEXTUP-START\n([\s\S]*?)\/\/ NEXTUP-END/.exec(html.replace(/\r\n/g, '\n'))?.[1];

interface Ev { at: number; ids: string[]; kind: string }
const nextUp: (now: number, sess?: unknown) => Ev[] = new Function(`${src}; return nextUp;`)();
const ENTRY_MIN: Record<string, number> = new Function(`${src}; return ENTRY_MIN;`)();

const MIN = 60_000;
const sess = { bounds: (name: 'LONDON' | 'NEW YORK', d: number) => sessionBounds(name, d) };

describe('Bot page countdown schedule', () => {
  it('was found in the page', () => {
    expect(src).toBeTruthy();
    expect(typeof nextUp).toBe('function');
  });

  it('uses the same entry times (IST minutes) as the backend for every fixed strategy', () => {
    for (const [id, slot] of Object.entries(SLOTS)) expect(ENTRY_MIN[id], id).toBe(slot.entryMin);
    expect(ENTRY_MIN.CAL_BACK).toBe(CAL_ENTRY_MIN_IST);
    expect(Object.keys(ENTRY_MIN).sort()).toEqual([...Object.keys(SLOTS), 'CAL_BACK'].sort());
  });

  it('lists the next starts in order, grouping strategies that share a time', () => {
    // 2026-10-28 06:30 UTC = 12:00 IST (Wednesday)
    const now = Date.parse('2026-10-28T06:30:00Z');
    const list = nextUp(now, sess);
    const times = list.map((e) => e.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // the first fixed start after 12:00 IST is the evening straddle at 17:30, but London's sweep window opens first (12:30 IST in UK summer time, 13:30 after clocks go back on 25 Oct)
    expect(list[0]!.ids).toEqual(['FUT_SWEEP_LDN']);
    const evening = list.find((e) => e.ids.includes('EVE_LONG'))!;
    expect(evening.at).toBe(runWindow('EVE_LONG', istDateKey(now)).entryAtMs);
    const ny = list.find((e) => e.ids.includes('NY_SHORT'))!;
    expect(ny.ids).toEqual(['NY_SHORT']);
    expect(ny.at).toBe(runWindow('NY_SHORT', istDateKey(now)).entryAtMs);
    const asiaTomorrow = list.find((e) => e.ids.includes('ASIA_SHORT'))!;
    expect(asiaTomorrow.ids).toEqual(['ASIA_SHORT']);
    expect(asiaTomorrow.at).toBe(runWindow('ASIA_SHORT', istDateKey(now + 86_400_000)).entryAtMs);
  });

  it('London and New York windows follow the daylight-saving calendar', () => {
    const summer = nextUp(Date.parse('2026-07-02T00:00:00Z'), sess).filter((e) => e.kind === 'window');
    const winter = nextUp(Date.parse('2026-12-02T00:00:00Z'), sess).filter((e) => e.kind === 'window');
    const ist = (ms: number) => ((ms + 19_800_000) % 86_400_000) / 3_600_000;
    const london = (l: Ev[]) => ist(l.find((e) => e.ids[0] === 'FUT_SWEEP_LDN')!.at);
    const ny = (l: Ev[]) => ist(l.find((e) => e.ids[0] === 'FUT_SWEEP_NY')!.at);
    expect(london(summer)).toBe(12.5);
    expect(london(winter)).toBe(13.5);
    expect(ny(summer)).toBe(19);
    expect(ny(winter)).toBe(20);
    void istDay;
  });

  it('keeps a start visible for 10 minutes after its time ("entering now"), then drops it', () => {
    const entry = runWindow('ASIA_SHORT', '2026-10-28').entryAtMs;
    expect(nextUp(entry + 5 * MIN)[0]!.ids).toEqual(expect.arrayContaining(['ASIA_SHORT']));
    expect(nextUp(entry + 11 * MIN).some((e) => e.ids.includes('ASIA_SHORT') && e.at === entry)).toBe(false);
  });

  it('works without the session calendar (fixed entries only) and never looks past 40 hours', () => {
    const now = Date.parse('2026-10-28T06:30:00Z');
    const list = nextUp(now);
    expect(list.every((e) => e.kind === 'entry')).toBe(true);
    expect(list.every((e) => e.at <= now + 40 * 3_600_000)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(4);
  });
});
