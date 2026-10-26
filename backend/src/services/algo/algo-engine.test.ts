import { describe, expect, it } from 'vitest';
import { AlgoEngine, type AlgoDeps, type Broker, type MarketData } from './algo-engine.js';
import { defaultStrangle, type AlgoStrategy } from '../../lib/algo/rule.js';
import { expiryCodeOf } from '../../lib/algo/plan.js';
import { istMidnightMs } from '../../lib/bot/schedule.js';
import type { ChainOption } from '../../lib/bot/strike-picker.js';
import type { RunRow, StrategyRow } from './algo-store.js';

const at = (date: string, hhmm: string) => istMidnightMs(date) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * 60_000;
const MON = '2026-10-26';
const E1 = Date.UTC(2026, 9, 27, 12), E2 = Date.UTC(2026, 9, 28, 12);
const opt = (type: 'call' | 'put', strike: number, delta: number, e: number): ChainOption => ({
  symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${strike}-${expiryCodeOf(e)}`, type, strike, expiryMs: e, delta, bid: 60, ask: 65, mark: 62, iv: 0.5,
});
const chain = [E1, E2].flatMap((e) => [opt('call', 105_000, 0.12, e), opt('put', 95_000, 0.12, e)]);
const market = (o: Partial<MarketData> = {}): MarketData => ({ spot: 100_000, chain, expiries: [E1, E2], dvol: 50, gateGo: true, gateReasons: [], bars5m: [], ...o });

function rig(rule: AlgoStrategy, nowRef: { t: number }, opts: { place?: Broker['place']; mk?: () => MarketData } = {}) {
  const runs: RunRow[] = [];
  const placed: unknown[] = [];
  const closed: string[] = [];
  const status = { open: true, netPnl: 0 as number | null, closedReason: null as string | null };
  const broker: Broker = {
    place: opts.place ?? (async (_u, _r, plan) => { placed.push(plan); return { ok: true, ref: 'basket-1', detail: 'ok' }; }),
    status: async () => ({ ...status }),
    closeAll: async (_u, _ref, reason) => { closed.push(reason); status.open = false; return { ok: true }; },
  };
  const strat: StrategyRow = { id: 's1', userId: 'u1', rule, lots: 50, armed: true, updatedAt: nowRef.t - 10 * 86_400_000 };
  const deps: AlgoDeps = {
    now: () => nowRef.t,
    armed: async () => [strat],
    openRuns: async () => runs.filter((r) => r.status === 'entered'),
    getRun: async (sid, dk) => runs.find((r) => r.strategyId === sid && r.dateKey === dk) ?? null,
    createRun: async (r) => {
      if (runs.some((x) => x.strategyId === r.strategyId && x.dateKey === r.dateKey)) return null;
      const row = { ...r, id: `r${runs.length + 1}`, exitedAt: null, exitReason: null, netPnl: null } as RunRow;
      runs.push(row);
      return row;
    },
    finishRun: async (id, s, why, pnl) => { const r = runs.find((x) => x.id === id)!; r.status = s; r.exitReason = why; r.netPnl = pnl; },
    market: async () => (opts.mk ? opts.mk() : market()),
    broker: () => broker,
  };
  return { engine: new AlgoEngine(deps), runs, placed, closed, status };
}

describe('AlgoEngine entry', () => {
  it('does nothing before the window, enters once inside it, never twice', async () => {
    const now = { t: at(MON, '22:00') };
    const r = rig(defaultStrangle(), now);
    await r.engine.tick();
    expect(r.placed).toHaveLength(0);
    expect(r.engine.checks.get('s1')!.state).toBe('before');
    now.t = at(MON, '22:30');
    await r.engine.tick();
    await r.engine.tick();
    expect(r.placed).toHaveLength(1);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.status).toBe('entered');
    expect(r.runs[0]!.lots).toBe(50);
    expect(r.runs[0]!.plan.why).toContain('hard entry at 22:30');
  });

  it('waits in a window until every condition passes, then enters once', async () => {
    const rule = defaultStrangle({ entry: { kind: 'window', from: '22:30', to: '01:30', conditions: [{ type: 'dvol', op: '<', value: 45 }, { type: 'gate' }] } });
    const now = { t: at(MON, '22:31') };
    let dvol = 50;
    const r = rig(rule, now, { mk: () => market({ dvol }) });
    await r.engine.tick();
    expect(r.placed).toHaveLength(0);
    expect(r.engine.checks.get('s1')!.state).toBe('waiting');
    expect(r.engine.checks.get('s1')!.results.map((x) => x.ok)).toEqual([false, true]);
    now.t = at(MON, '23:40');
    dvol = 40;
    await r.engine.tick();
    expect(r.placed).toHaveLength(1);
    now.t = at(MON, '23:45');
    await r.engine.tick();
    expect(r.placed).toHaveLength(1);
  });

  it('a window that ends without a fit is recorded as skipped with the reason', async () => {
    const rule = defaultStrangle({ entry: { kind: 'window', from: '22:30', to: '23:30', conditions: [{ type: 'dvol', op: '<', value: 45 }] } });
    const now = { t: at(MON, '23:00') };
    const r = rig(rule, now);
    await r.engine.tick();
    now.t = at(MON, '23:40');
    await r.engine.tick();
    await r.engine.tick();
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.status).toBe('skipped');
    expect(r.runs[0]!.reason).toContain('DVOL');
    expect(r.placed).toHaveLength(0);
  });

  it('a refused order is recorded as failed and is not retried that day', async () => {
    const now = { t: at(MON, '22:30') };
    let tries = 0;
    const r = rig(defaultStrangle(), now, { place: async () => { tries++; return { ok: false, reason: 'insufficient margin' }; } });
    await r.engine.tick();
    await r.engine.tick();
    expect(tries).toBe(1);
    expect(r.runs[0]!.status).toBe('failed');
    expect(r.runs[0]!.reason).toContain('margin');
  });

  it('a dry live run is recorded as dry and not tracked', async () => {
    const now = { t: at(MON, '22:30') };
    const r = rig(defaultStrangle({ mode: 'live' }), now, { place: async () => ({ ok: true, dry: true, ref: 'dry', detail: 'DRY RUN' }) });
    await r.engine.tick();
    expect(r.runs[0]!.status).toBe('dry');
    await r.engine.tick();
    expect(r.closed).toHaveLength(0);
  });

  it('does not trade a day that was not selected', async () => {
    const now = { t: at('2026-10-27', '22:30') };
    const r = rig(defaultStrangle({ days: ['mon'] }), now);
    await r.engine.tick();
    expect(r.placed).toHaveLength(0);
  });

  it('says why when the plan cannot be built', async () => {
    const now = { t: at(MON, '22:30') };
    const r = rig(defaultStrangle(), now, { mk: () => market({ chain: [] }) });
    await r.engine.tick();
    expect(r.placed).toHaveLength(0);
    expect(r.engine.checks.get('s1')!.planReason).toMatch(/delta/);
  });

  it('a futures strategy enters with the command lots', async () => {
    const rule: AlgoStrategy = { ...defaultStrangle(), instrument: 'future', legs: [], future: { side: 'long' } };
    const now = { t: at(MON, '22:30') };
    const r = rig(rule, now);
    await r.engine.tick();
    expect(r.placed[0]).toMatchObject({ kind: 'future', future: { side: 'long', lots: 50 } });
  });
});

describe('AlgoEngine exit', () => {
  const enter = async (rule: AlgoStrategy) => {
    const now = { t: at(MON, '22:30') };
    const r = rig(rule, now);
    await r.engine.tick();
    return { ...r, now };
  };

  it('exits everything at the net target', async () => {
    const r = await enter(defaultStrangle({ exit: { ...defaultStrangle().exit, netTargetUsd: 20 } }));
    r.status.netPnl = 10;
    await r.engine.tick();
    expect(r.closed).toHaveLength(0);
    r.status.netPnl = 25;
    await r.engine.tick();
    expect(r.closed[0]).toContain('net target');
    expect(r.runs[0]!.status).toBe('exited');
    expect(r.runs[0]!.netPnl).toBe(25);
  });

  it('exits everything at the net stop', async () => {
    const r = await enter(defaultStrangle({ exit: { ...defaultStrangle().exit, netStopUsd: 15 } }));
    r.status.netPnl = -16;
    await r.engine.tick();
    expect(r.closed[0]).toContain('net stop');
  });

  it('exits at the exit time', async () => {
    const r = await enter(defaultStrangle({ exit: { ...defaultStrangle().exit, exitTime: '07:00' } }));
    r.now.t = at('2026-10-27', '06:59');
    await r.engine.tick();
    expect(r.closed).toHaveLength(0);
    r.now.t = at('2026-10-27', '07:00');
    await r.engine.tick();
    expect(r.closed[0]).toContain('exit time 07:00');
  });

  it('records a position that its own stops already closed', async () => {
    const r = await enter(defaultStrangle());
    r.status.open = false;
    r.status.closedReason = 'stop hit';
    r.status.netPnl = -40;
    await r.engine.tick();
    expect(r.runs[0]!.status).toBe('exited');
    expect(r.runs[0]!.exitReason).toBe('stop hit');
  });

  it('keeps tracking when the account cannot be read this tick', async () => {
    const now = { t: at(MON, '22:30') };
    const r = rig(defaultStrangle({ exit: { ...defaultStrangle().exit, netTargetUsd: 5 } }), now);
    await r.engine.tick();
    (r.engine as unknown as { d: AlgoDeps }).d.broker = () => ({ place: async () => ({ ok: false, reason: 'x' }), status: async () => null, closeAll: async () => ({ ok: true }) });
    await r.engine.tick();
    expect(r.runs[0]!.status).toBe('entered');
  });

  it('futures stop and target in percent', async () => {
    const rule: AlgoStrategy = { ...defaultStrangle(), instrument: 'future', legs: [], future: { side: 'long' }, exit: { ...defaultStrangle().exit, futTargetPct: 2, futStopPct: 1 } };
    const now = { t: at(MON, '22:30') };
    const r = rig(rule, now);
    await r.engine.tick();
    const broker = (r.engine as unknown as { d: AlgoDeps }).d;
    let mark = 100_500;
    broker.broker = () => ({ place: async () => ({ ok: false, reason: 'x' }), status: async () => ({ open: true, netPnl: 5, future: { entry: 100_000, mark, side: 'long' as const } }), closeAll: async (_u, _r2, why) => { r.closed.push(why); return { ok: true }; } });
    await r.engine.tick();
    expect(r.closed).toHaveLength(0);
    mark = 102_100;
    await r.engine.tick();
    expect(r.closed[0]).toContain('target');
  });
});
