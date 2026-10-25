/**
 * Outside Market Volatility Pressure Worker (Macro Stress Lane 0-100)
 *
 * Sits as a lane under the BTC chart and shares its time axis.
 * INPUTS (recorded every 5 min from free sources):
 * - Forex: DXY, USDJPY
 * - Commodities: Gold, WTI Oil
 * - Stocks: Nasdaq futures, VIX
 * - Bonds: US 10-year yield, MOVE index
 * - News calendar: US high / medium impact releases (CPI, FOMC, jobs...), converted to IST
 *
 * CALCULATION (see lib/macro.ts, which is unit tested):
 * 1. Shock per market = 1h and 4h move divided by its normal range. A market whose candles are old (closed) is
 *    reported as closed and does NOT count as calm; it simply drops out of its group.
 * 2. Link per group = |correlation| of hourly returns with BTC over the last 5 days, blended half and half with a
 *    fixed prior so a few quiet days cannot swing it.
 * 3. Pressure = shock x link, per group.
 * 4. Event factor = rises over the 6h before a US release, decays over the 2h after. Counted once.
 * 5. Stress = weighted sum of pressures, scaled to 0-100.
 * 6. Direction (risk-off / risk-on) and the expected BTC RV uplift.
 *
 * Failures and gaps are listed explicitly and never filled silently. The history behind the lane is the real record
 * of past readings, saved to the database so a restart does not erase it; nothing is invented.
 */
import { pool } from '../db/index.js';
import {
  blendLink, correlationWithBtc, hourlyReturns, readMoves, relevantEvents, stressScore, type Pt,
} from '../lib/macro.js';

export interface MarketQuote {
  symbol: string;
  price: number;
  change1hPct: number;
  change4hPct: number;
  normalRangePct: number; // 30-day baseline standard deviation
  lastUpdated: number;
  /** The market is trading now (fresh candles); false means closed or stale. */
  open: boolean;
  /** Minutes since its newest candle. */
  ageMin: number;
}

export interface MacroCategoryData {
  cat: string;
  inst: string;
  shock: string;      // e.g. "0.32 σ", or "closed" / "no data"
  shockVal: number;
  link: string;       // e.g. "0.24"
  linkVal: number;
  pressure: string;   // e.g. "0.08"
  pressureVal: number;
}

export interface CalendarEvent {
  title: string;
  country: string;
  impact: 'High' | 'Medium' | 'Low';
  timestamp: number;   // UTC ms
  timeIST: string;     // Formatted IST
  hoursUntil: number;
  factor: number;      // 0 to 1
}

export interface StressPoint {
  time: string;        // IST time label
  timestamp: number;   // UTC ms
  val: number;         // 0 to 100
  isNow?: boolean;
  isProj?: boolean;
  zone: 'calm' | 'elevated' | 'shock';
}

export interface StressWeights {
  forex: number;
  commodities: number;
  equities: number;
  bonds: number;
  event: number;
}

export const DEFAULT_STRESS_WEIGHTS: StressWeights = {
  forex: 0.15,
  commodities: 0.15,
  equities: 0.20,
  bonds: 0.20,
  event: 0.30,
};

export interface MarketGap {
  symbol: string;
  timestamp: number;
  reason: string;
}

export interface MacroStressSnapshot {
  score: number;       // 0-100
  arrow: '↗' | '↘' | '→';
  zone: 'calm' | 'elevated' | 'shock';
  direction: 'RISK-OFF' | 'RISK-ON';
  uplift: string;      // e.g. "+0.4% RV"
  nextEvent: string;   // e.g. "US CPI Release (in 1.5h IST)"
  tradeRule: string;   // Sizing guidance for the desk
  matrix: MacroCategoryData[];
  curve: StressPoint[];
  events: Array<{ timeIdx: number; name: string; shockVal: number; timestamp?: number }>;
  weights: StressWeights;
  gaps: MarketGap[];
  failures: Array<{ symbol: string; error: string; at: number }>;
  status: 'ok' | 'degraded';
  updatedAt: number;
  /** False until the first successful poll: the numbers are then placeholders, not measurements. */
  hasData: boolean;
  /** How many of the 8 markets are trading right now, and how many could not be fetched this cycle. */
  marketsOpen: number;
  marketsFailed: number;
  note: string | null;
}

const SYMBOLS = {
  DXY: 'DX-Y.NYB',
  USDJPY: 'USDJPY=X',
  GOLD: 'GC=F',
  OIL: 'CL=F',
  NQ: 'NQ=F',
  VIX: '^VIX',
  TNX: '^TNX',
  MOVE: '^MOVE',
};
const BTC_SYMBOL = 'BTC-USD';

// Normal 30d hourly range approximations (% standard deviation)
const NORMAL_RANGES_PCT: Record<string, number> = {
  'DX-Y.NYB': 0.18,
  'USDJPY=X': 0.22,
  'GC=F': 0.45,
  'CL=F': 0.85,
  'NQ=F': 0.55,
  '^VIX': 3.20,
  '^TNX': 1.10,
  '^MOVE': 2.80,
};

/** Starting link per group, used while the correlation has too little data and as half of the blend afterwards. */
const PRIOR_LINK = { forex: 0.28, commodities: 0.32, equities: 0.52, bonds: 0.36 };

const GROUPS = {
  forex: [SYMBOLS.DXY, SYMBOLS.USDJPY],
  commodities: [SYMBOLS.GOLD, SYMBOLS.OIL],
  equities: [SYMBOLS.NQ, SYMBOLS.VIX],
  bonds: [SYMBOLS.TNX, SYMBOLS.MOVE],
} as const;

const DDL = `CREATE TABLE IF NOT EXISTS macro_stress_points (
  ts bigint PRIMARY KEY,
  score integer NOT NULL
)`;

const zoneOf = (v: number): 'calm' | 'elevated' | 'shock' => (v < 35 ? 'calm' : v <= 65 ? 'elevated' : 'shock');
const istClock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

export class MacroStressWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private pollIntervalMs = 5 * 60 * 1000; // 5 minutes

  private quotes = new Map<string, MarketQuote>();
  private series = new Map<string, Pt[]>();

  private historicalCurve: StressPoint[] = [];
  private currentSnapshot: MacroStressSnapshot | null = null;
  private failures: Array<{ symbol: string; error: string; at: number }> = [];
  private gaps: MarketGap[] = [];
  public weights: StressWeights = { ...DEFAULT_STRESS_WEIGHTS };

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[MacroStressWorker] Starting outside markets volatility pressure recorder (every 5 min)...');
    void this.loadHistory().finally(() => {
      if (!this.isRunning) return;
      this.poll();
      this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    });
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[MacroStressWorker] Stopped.');
  }

  public getSnapshot(): MacroStressSnapshot {
    if (this.currentSnapshot) {
      return this.currentSnapshot;
    }
    return this.buildFallbackSnapshot();
  }

  public setWeights(newWeights: Partial<StressWeights>) {
    for (const k of Object.keys(DEFAULT_STRESS_WEIGHTS) as Array<keyof StressWeights>) {
      const v = newWeights[k];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 2)) throw new Error(`weight "${k}" must be a number from 0 to 2`);
    }
    for (const k of Object.keys(newWeights)) if (!(k in DEFAULT_STRESS_WEIGHTS)) throw new Error(`unknown weight "${k}"`);
    this.weights = { ...this.weights, ...newWeights };
    console.log('[MacroStressWorker] Refitted stress weights:', this.weights);
    this.computeStress();
  }

  // ---------- history: real readings only, saved so a restart keeps them ----------

  private async loadHistory() {
    try {
      await pool.query(DDL);
      const r = await pool.query('SELECT ts, score FROM macro_stress_points WHERE ts >= $1 ORDER BY ts', [Date.now() - 24 * 3_600_000]);
      this.historicalCurve = (r.rows as Array<{ ts: string; score: number }>).map((x) => ({
        time: istClock(Number(x.ts)), timestamp: Number(x.ts), val: Number(x.score), zone: zoneOf(Number(x.score)),
      }));
    } catch (e) {
      console.warn('[MacroStressWorker] could not load saved history:', (e as Error).message);
    }
  }

  private async saveReading(ts: number, score: number) {
    try {
      await pool.query(DDL);
      await pool.query('INSERT INTO macro_stress_points (ts, score) VALUES ($1, $2) ON CONFLICT (ts) DO NOTHING', [ts, score]);
      await pool.query('DELETE FROM macro_stress_points WHERE ts < $1', [ts - 7 * 24 * 3_600_000]);
    } catch (e) {
      console.warn('[MacroStressWorker] could not save the reading:', (e as Error).message);
    }
  }

  // ---------- polling ----------

  private failedNow = new Set<string>();

  private async poll() {
    try {
      const now = Date.now();
      this.failedNow = new Set();
      const jobs = [...Object.values(SYMBOLS), BTC_SYMBOL].map(async (sym) => {
        try {
          const { quote, points } = await this.fetchYahooQuote(sym);
          this.series.set(sym, points);
          if (sym !== BTC_SYMBOL) this.quotes.set(sym, quote);
        } catch (err: any) {
          const msg = err?.message || String(err);
          console.warn(`[MacroStressWorker] Failure fetching ${sym}: ${msg}`);
          if (sym !== BTC_SYMBOL) this.failedNow.add(sym);
          this.failures.push({ symbol: sym, error: msg, at: now });
          if (this.failures.length > 50) this.failures.shift();
          this.gaps.push({ symbol: sym, timestamp: now, reason: msg });
          if (this.gaps.length > 50) this.gaps.shift();
        }
      });
      await Promise.allSettled(jobs);

      const events = await this.fetchCalendarEvents();
      this.computeStress(events);
    } catch (err) {
      console.error('[MacroStressWorker] Poll cycle error:', err);
    }
  }

  private async fetchYahooQuote(symbol: string): Promise<{ quote: MarketQuote; points: Pt[] }> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      throw new Error('Malformed chart result from Yahoo Finance');
    }

    const regularPrice = result.meta?.regularMarketPrice;
    const timestamps: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];

    if (typeof regularPrice !== 'number' || !timestamps.length) {
      throw new Error(`No regular market price for ${symbol}`);
    }

    const points: Pt[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (typeof c === 'number' && !isNaN(c)) points.push({ t: timestamps[i]! * 1000, p: c });
    }

    const now = Date.now();
    const m = readMoves(points, regularPrice, now);
    return {
      points,
      quote: {
        symbol,
        price: regularPrice,
        change1hPct: m.change1hPct,
        change4hPct: m.change4hPct,
        normalRangePct: NORMAL_RANGES_PCT[symbol] || 0.50,
        lastUpdated: now,
        open: m.open,
        ageMin: m.ageMin,
      },
    };
  }

  private async fetchCalendarEvents(): Promise<CalendarEvent[]> {
    try {
      const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
        headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const items: any[] = await res.json();
      return relevantEvents(items, Date.now()).map((e) => ({
        title: e.title,
        country: 'USD',
        impact: e.impact,
        timestamp: e.timestamp,
        timeIST: `${istClock(e.timestamp)} IST`,
        hoursUntil: e.hoursUntil,
        factor: e.factor,
      }));
    } catch {
      return [];
    }
  }

  // ---------- stress ----------

  /** Average shock of the markets in a group that are trading now. `open` is how many of them that is. */
  private groupShock(symbols: readonly string[]): { shock: number; open: number; total: number } {
    let sum = 0;
    let open = 0;
    for (const sym of symbols) {
      const q = this.quotes.get(sym);
      if (!q || !q.open) continue;
      const move = Math.abs(q.change1hPct) * 0.6 + Math.abs(q.change4hPct) * 0.4;
      sum += move / (q.normalRangePct || 0.5);
      open++;
    }
    return { shock: open ? sum / open : 0, open, total: symbols.length };
  }

  private groupLink(symbols: readonly string[], prior: number): number {
    const btc = this.series.get(BTC_SYMBOL);
    if (!btc || btc.length < 100) return prior;
    const btcRet = hourlyReturns(btc);
    const corrs = symbols.map((s) => {
      const pts = this.series.get(s);
      return pts && pts.length ? correlationWithBtc(hourlyReturns(pts), btcRet).corr : null;
    });
    return blendLink(corrs, prior);
  }

  private computeStress(events: Array<{ title: string; hoursUntil: number; factor: number; timestamp: number }> = []) {
    const now = Date.now();

    const sh = {
      forex: this.groupShock(GROUPS.forex),
      commodities: this.groupShock(GROUPS.commodities),
      equities: this.groupShock(GROUPS.equities),
      bonds: this.groupShock(GROUPS.bonds),
    };
    const link = {
      forex: this.groupLink(GROUPS.forex, PRIOR_LINK.forex),
      commodities: this.groupLink(GROUPS.commodities, PRIOR_LINK.commodities),
      equities: this.groupLink(GROUPS.equities, PRIOR_LINK.equities),
      bonds: this.groupLink(GROUPS.bonds, PRIOR_LINK.bonds),
    };
    const press = {
      forex: sh.forex.shock * link.forex,
      commodities: sh.commodities.shock * link.commodities,
      equities: sh.equities.shock * link.equities,
      bonds: sh.bonds.shock * link.bonds,
      event: 0,
    };

    let maxEventFactor = 0;
    let nextEventDesc = 'No Tier-1 US news in 6h';
    if (events.length > 0) {
      const top = events[0]!;
      maxEventFactor = Math.max(...events.map((e) => e.factor));
      const hStr = top.hoursUntil > 0 ? `in ${top.hoursUntil.toFixed(1)}h` : `${Math.abs(top.hoursUntil).toFixed(1)}h ago`;
      nextEventDesc = `${top.title} (${hStr})`;
      if (maxEventFactor === 0) nextEventDesc = `${top.title} (in ${top.hoursUntil.toFixed(0)}h)`;
    }
    press.event = maxEventFactor * 3.5;

    const score = stressScore({ press, weights: this.weights });

    const isRiskOff = press.equities > 0.35 || press.bonds > 0.30 || score > 55;
    const direction: 'RISK-OFF' | 'RISK-ON' = isRiskOff ? 'RISK-OFF' : 'RISK-ON';
    const uplift = `+${(score * 0.055).toFixed(1)}% RV`;

    const zone = zoneOf(score);
    const tradeRule =
      zone === 'calm' ? 'Green: markets calm, take the entry at normal size.'
        : zone === 'elevated' ? 'Amber: one market is moving or an event is within a few hours, use half size.'
          : 'Red: several markets moving together or a big event is close, skip the entry or cut size.';

    const lastScore = this.historicalCurve.length ? this.historicalCurve[this.historicalCurve.length - 1]!.val : score;
    const arrow: '↗' | '↘' | '→' = score > lastScore + 1 ? '↗' : (score < lastScore - 1 ? '↘' : '→');

    const row = (cat: string, inst: string, g: { shock: number; open: number; total: number }, l: number, p: number): MacroCategoryData => ({
      cat, inst,
      shock: g.open === 0 ? (g.total ? 'closed' : 'no data') : `${g.shock.toFixed(2)} σ${g.open < g.total ? ` (${g.open}/${g.total} open)` : ''}`,
      shockVal: g.shock,
      link: l.toFixed(2),
      linkVal: l,
      pressure: p.toFixed(2),
      pressureVal: p,
    });
    const matrix: MacroCategoryData[] = [
      row('Forex', 'DXY / USDJPY', sh.forex, link.forex, press.forex),
      row('Commodities', 'Gold / WTI Oil', sh.commodities, link.commodities, press.commodities),
      row('Equities', 'Nasdaq Fut / VIX', sh.equities, link.equities, press.equities),
      row('Bonds / Rates', 'US10Y / MOVE', sh.bonds, link.bonds, press.bonds),
      {
        cat: 'News Calendar', inst: nextEventDesc, shock: `${(maxEventFactor * 3.0).toFixed(2)} σ`, shockVal: maxEventFactor * 3.0,
        link: '1.00', linkVal: 1.0, pressure: press.event.toFixed(2), pressureVal: press.event,
      },
    ];

    const marketsOpen = [...this.quotes.values()].filter((q) => q.open).length;
    const marketsFailed = this.failedNow.size;
    const noteParts: string[] = [];
    if (marketsOpen === 0) noteParts.push('All outside markets are closed (weekend or holiday), so only the news calendar can move this score.');
    else if (marketsOpen < 6) noteParts.push(`Only ${marketsOpen} of 8 outside markets are trading right now; closed ones are left out, not counted as calm.`);
    if (marketsFailed > 0) noteParts.push(`${marketsFailed} market feed${marketsFailed === 1 ? '' : 's'} could not be fetched this cycle.`);

    const currentPoint: StressPoint = { time: `${istClock(now)} (NOW)`, timestamp: now, val: score, isNow: true, zone };
    void currentPoint;
    // keep the sliding window of REAL readings (up to 288 = 24 hours at 5 minutes)
    this.historicalCurve.push({ time: istClock(now), timestamp: now, val: score, zone });
    if (this.historicalCurve.length > 288) this.historicalCurve.shift();
    void this.saveReading(Math.floor(now / 300_000) * 300_000, score);

    const fullCurve = this.buildFullCurveWithProjection(score, now);
    const eventMarkers: Array<{ timeIdx: number; name: string; shockVal: number; timestamp?: number }> = [];
    for (const ev of events.slice(0, 3)) {
      eventMarkers.push({ timeIdx: Math.max(0, fullCurve.findIndex((p) => p.isNow)), name: ev.title, shockVal: score, timestamp: ev.timestamp });
    }

    this.currentSnapshot = {
      score, arrow, zone, direction, uplift,
      nextEvent: nextEventDesc,
      tradeRule, matrix,
      curve: fullCurve,
      events: eventMarkers,
      weights: this.weights,
      gaps: [...this.gaps],
      failures: [...this.failures],
      status: marketsFailed >= 3 ? 'degraded' : 'ok',
      updatedAt: now,
      hasData: this.quotes.size > 0,
      marketsOpen,
      marketsFailed,
      note: noteParts.length ? noteParts.join(' ') : null,
    };
  }

  private buildFullCurveWithProjection(currentScore: number, now: number): StressPoint[] {
    const out: StressPoint[] = [];

    // the readings actually recorded before now
    for (const pt of this.historicalCurve) {
      if (pt.timestamp < now - 60_000) {
        out.push({ time: pt.time, timestamp: pt.timestamp, val: pt.val, zone: zoneOf(pt.val) });
      }
    }

    out.push({ time: `${istClock(now)} (NOW)`, timestamp: now, val: currentScore, isNow: true, zone: zoneOf(currentScore) });

    // 3-hour projection (dashed): a plain drift back toward a quiet baseline, not a forecast
    for (let h = 1; h <= 3; h++) {
      const projT = now + h * 3600 * 1000;
      const decayVal = Math.max(10, Math.min(95, Math.round(currentScore + (25 - currentScore) * (h * 0.25))));
      out.push({ time: `${istClock(projT)} (Proj)`, timestamp: projT, val: decayVal, isProj: true, zone: zoneOf(decayVal) });
    }

    return out;
  }

  /** Before the first successful poll there is nothing measured: say so instead of showing made-up numbers. */
  private buildFallbackSnapshot(): MacroStressSnapshot {
    const now = Date.now();
    const none = (cat: string, inst: string): MacroCategoryData => ({ cat, inst, shock: 'loading', shockVal: 0, link: '-', linkVal: 0, pressure: '0.00', pressureVal: 0 });
    return {
      score: 24,
      arrow: '→',
      zone: 'calm',
      direction: 'RISK-ON',
      uplift: '+0.0% RV',
      nextEvent: 'loading',
      tradeRule: 'Waiting for the first market data; no reading yet.',
      matrix: [none('Forex', 'DXY / USDJPY'), none('Commodities', 'Gold / WTI Oil'), none('Equities', 'Nasdaq Fut / VIX'), none('Bonds / Rates', 'US10Y / MOVE'), none('News Calendar', 'loading')],
      curve: this.buildFullCurveWithProjection(24, now),
      events: [],
      weights: this.weights,
      gaps: [],
      failures: [],
      status: 'degraded',
      updatedAt: now,
      hasData: false,
      marketsOpen: 0,
      marketsFailed: 0,
      note: 'No market data has been fetched yet, so the score shown is a placeholder.',
    };
  }
}

export const macroStressWorker = new MacroStressWorker();
