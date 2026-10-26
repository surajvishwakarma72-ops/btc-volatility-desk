import { describe, expect, it, vi } from 'vitest';
import { WatchService, type WatchConfig, type WatchGroup, type WatchSources } from './watch.js';
import type { WatchLeg } from '../../lib/watch/classify.js';

const cfg: WatchConfig = { warnPoints: 20, hardPoints: 5, stopMultiple: 2, watchReal: true, liveArmed: false, dryRun: true };
const OWNER = 'owner', FRIEND = 'friend';
const leg = (source: WatchLeg['source'], group: string, symbol: string, mark: number | null, entry = 100, stop = 200): WatchLeg => ({ source, group, groupLabel: group + ' label', symbol, side: 'sold', entry, mark, stop, lots: 100 });

function make(state: { bot?: WatchLeg[]; paper?: Record<string, WatchLeg[]>; real?: Record<string, WatchLeg[] | null>; botError?: boolean; realError?: boolean }, over: Partial<WatchSources> = {}) {
  let t = 1_000_000;
  const hard: Array<{ uid: string; group: WatchGroup }> = [];
  const src: WatchSources = {
    users: async () => [OWNER, FRIEND],
    isOwner: (id) => id === OWNER,
    config: async () => cfg,
    bot: async () => { if (state.botError) throw new Error('chain down'); return state.bot ?? []; },
    paper: async (id) => state.paper?.[id] ?? [],
    real: async (id) => { if (state.realError) throw new Error('Delta said no'); return state.real?.[id] ?? null; },
    hardExit: async (uid, group) => { hard.push({ uid, group }); },
    ...over,
  };
  const svc = new WatchService(src, () => t);
  return { svc, hard, advance: (ms: number) => { t += ms; }, state };
}

describe('the stop alarm', () => {
  it('raises an alarm for a strangle when one leg is 20 points from its stop, and shows BOTH legs', async () => {
    const m = make({ bot: [leg('bot', 'run1', 'C-82000', 150), leg('bot', 'run1', 'P-78000', 120, 120, 240)] });
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms).toHaveLength(0);
    m.state.bot = [leg('bot', 'run1', 'C-82000', 180), leg('bot', 'run1', 'P-78000', 120, 120, 240)];
    await m.svc.tick();
    const a = m.svc.snapshotFor(OWNER)!.alarms;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ source: 'bot', level: 'warn', label: 'run1 label' });
    expect(a[0]!.legs.map((l) => l.symbol)).toEqual(['C-82000', 'P-78000']);
    expect(a[0]!.legs[0]).toMatchObject({ pointsLeft: 20, level: 'warn', stop: 200 });
    expect(a[0]!.legs[1]).toMatchObject({ pointsLeft: 120, level: 'safe' });
  });
  it('keeps the alarm on until the leg is clearly back, remembers when it began, and then clears', async () => {
    const m = make({ bot: [leg('bot', 'r', 'C', 185)] });
    await m.svc.tick();
    const since = m.svc.snapshotFor(OWNER)!.alarms[0]!.since;
    expect(since).toBe(1_000_000);
    m.advance(5000);
    m.state.bot = [leg('bot', 'r', 'C', 178)]; // 22 points left: still inside the extra margin
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms[0]).toMatchObject({ level: 'warn', since });
    m.state.bot = [leg('bot', 'r', 'C', 170)]; // 30 left: back to safe
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms).toHaveLength(0);
    m.state.bot = [leg('bot', 'r', 'C', 182)]; // a new episode starts a new clock
    m.advance(60_000);
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms[0]!.since).toBeGreaterThan(since!);
  });
  it('moves from warn to hard to breach as the mark climbs', async () => {
    const m = make({ bot: [leg('bot', 'r', 'C', 180)] });
    const lv = async (mark: number) => { m.state.bot = [leg('bot', 'r', 'C', mark)]; await m.svc.tick(); return m.svc.snapshotFor(OWNER)!.alarms[0]!.level; };
    expect(await lv(180)).toBe('warn');
    expect(await lv(196)).toBe('hard');
    expect(await lv(201)).toBe('breach');
  });
  it('shows the bot only to the owner, and each person only their own paper strategies and Delta positions', async () => {
    const m = make({ bot: [leg('bot', 'b', 'C', 190)], paper: { [FRIEND]: [leg('paper', 'p', 'C', 190)] }, real: { [OWNER]: [leg('delta', '261027', 'C', 190)] } });
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms.map((g) => g.source).sort()).toEqual(['bot', 'delta']);
    expect(m.svc.snapshotFor(FRIEND)!.alarms.map((g) => g.source)).toEqual(['paper']);
  });
  it('says so when a source cannot be read, instead of showing "all safe"', async () => {
    const m = make({ botError: true, realError: true, real: {} });
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.problems.join(' ')).toMatch(/bot positions unreadable: chain down/);
    expect(m.svc.snapshotFor(OWNER)!.problems.join(' ')).toMatch(/Delta positions unreadable: Delta said no/);
    expect(m.svc.snapshotFor(FRIEND)!.problems.join(' ')).toMatch(/Delta positions unreadable/);
  });
  it('does not read real positions for someone who switched real watching off', async () => {
    const real = vi.fn(async () => [leg('delta', 'x', 'C', 190)]);
    const m = make({}, { config: async () => ({ ...cfg, watchReal: false }), real });
    await m.svc.tick();
    expect(real).not.toHaveBeenCalled();
  });
  it('a leg with no price yet is not an alarm and does not break the group', async () => {
    const m = make({ bot: [leg('bot', 'r', 'C', null), leg('bot', 'r', 'P', 150)] });
    await m.svc.tick();
    expect(m.svc.snapshotFor(OWNER)!.alarms).toHaveLength(0);
    expect(m.svc.snapshotFor(OWNER)!.groups[0]!.legs[0]!.pointsLeft).toBeNull();
  });
  it('a failure for one user does not stop the others', async () => {
    const m = make({}, { config: async (id) => { if (id === OWNER) throw new Error('db blip'); return cfg; }, paper: async () => [leg('paper', 'p', 'C', 190)] });
    await m.svc.tick();
    expect(m.svc.snapshotFor(FRIEND)!.alarms).toHaveLength(1);
    expect(m.svc.lastError).toMatch(/db blip/);
  });
});

describe('handing a real position to the hard exit', () => {
  it('calls it for a real (Delta) position at the hard-exit distance, with the whole group, and not before', async () => {
    const m = make({ real: { [OWNER]: [leg('delta', '261027', 'C', 184), leg('delta', '261027', 'P', 130, 120, 240)] } });
    await m.svc.tick();
    expect(m.hard).toHaveLength(0); // 16 points left: warn, not yet hard
    m.state.real = { [OWNER]: [leg('delta', '261027', 'C', 195.5), leg('delta', '261027', 'P', 130, 120, 240)] };
    await m.svc.tick();
    expect(m.hard).toHaveLength(1);
    expect(m.hard[0]!.uid).toBe(OWNER);
    expect(m.hard[0]!.group.legs.map((l) => l.symbol)).toEqual(['C', 'P']);
  });
  it('never calls it for the paper bot or paper strategies, which have their own exits', async () => {
    const m = make({ bot: [leg('bot', 'b', 'C', 199)], paper: { [OWNER]: [leg('paper', 'p', 'C', 199)] } });
    await m.svc.tick();
    expect(m.hard).toHaveLength(0);
  });
  it('a failing hard exit is recorded and does not stop the watching', async () => {
    const m = make({ real: { [OWNER]: [leg('delta', 'e', 'C', 199)] } }, { hardExit: async () => { throw new Error('exchange down'); } });
    await m.svc.tick();
    expect(m.svc.lastError).toMatch(/hard exit: exchange down/);
    expect(m.svc.snapshotFor(OWNER)!.alarms).toHaveLength(1);
  });
});
