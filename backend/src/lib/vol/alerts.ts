/**
 * Volatility alerts (9.7 transition alerts, 9.6a step 6 tripwires). Pure: the worker keeps the state between runs.
 *
 * Regime changes use a small dead band: a percentile sitting on a band edge (40.0 vs 39.9) must not flip the regime and
 * send a message every few minutes. A new regime is taken only once the percentile is `HYST` points past the edge.
 */
import { H, DAY } from '../calendar/time.js';
import { regimeOf, VOL_CONFIG, type Bar, type Compression, type Regime, type VolRead } from './regime.js';

export const HYST = 2;
const ORDER: Regime[] = ['Dead', 'Low', 'Core', 'Rich', 'Crisis'];

/** Regime with hysteresis: stay in `prev` unless `pct` is clearly inside another band. */
export function stickyRegime(prev: Regime | null, pct: number, cfg = VOL_CONFIG): Regime {
  const raw = regimeOf(pct, cfg);
  if (!prev || raw === prev) return raw;
  const edges = cfg.bands;
  const i = ORDER.indexOf(prev), j = ORDER.indexOf(raw);
  // the edge between prev and its neighbour in the direction of travel
  const edge = j > i ? edges[i]! : edges[i - 1]!;
  return Math.abs(pct - edge) >= HYST ? raw : prev;
}

export interface VolState {
  regime: Regime | null;
  regimeSince: number;
  /** When the regime last left Crisis (for the "first sellable window" alert). */
  fromCrisisAt: number | null;
  firstWindowSent: boolean;
  compression: Compression;
  compressionSince: number;
  /** Start of an unbroken Dead/Low spell, and whether its 3-week alert went out. */
  lowSince: number | null;
  lowAlertSent: boolean;
  /** The quiet range a tripwire last fired for, so one break gives one alert. */
  trippedKey: string | null;
}

export interface VolAlert { kind: 'regime' | 'compression' | 'building'; title: string; message: string }

export const initialState = (now: number): VolState => ({
  regime: null, regimeSince: now, fromCrisisAt: null, firstWindowSent: false, compression: 'Normal', compressionSince: now,
  lowSince: null, lowAlertSent: false, trippedKey: null,
});

const pct0 = (x: number | null) => (x == null ? '—' : Math.round(x).toString());

export function volTransitions(prev: VolState, r: VolRead, now: number): { state: VolState; alerts: VolAlert[] } {
  const s: VolState = { ...prev };
  const alerts: VolAlert[] = [];
  const iv = `IV ${r.iv.now?.toFixed(1) ?? '—'}, percentile ${pct0(r.iv.pct)}`;

  if (r.iv.pct != null) {
    const next = stickyRegime(prev.regime, r.iv.pct);
    if (prev.regime && next !== prev.regime) {
      const from = prev.regime, rising = ORDER.indexOf(next) > ORDER.indexOf(from);
      let title = `IV regime ${from} → ${next}`, message = `${iv}. ${next}: ${rising ? 'IV rising' : 'IV falling'}.`;
      if (from === 'Low' && next === 'Core') message = `${iv}. IV is waking up: tighten exits on open trades.`;
      else if (from === 'Rich' && next === 'Core') { title = 'Best sell window: IV falling from Rich into Core'; message = `${iv}. Premium still good and IV turning down: the window the rule book likes best.`; }
      else if (from === 'Core' && next === 'Rich') message = `${iv}. IV spiking: no new strangle until it settles and starts falling; half size then.`;
      else if (next === 'Crisis') message = `${iv}. Crisis regime: no new strangles; manage or close open ones.`;
      else if (next === 'Dead') message = `${iv}. Dead IV: no sale until a wake-up wave.`;
      alerts.push({ kind: 'regime', title, message });
      if (from === 'Crisis') { s.fromCrisisAt = now; s.firstWindowSent = false; }
      s.regime = next; s.regimeSince = now;
    } else if (!prev.regime) { s.regime = next; s.regimeSince = now; }

    // Crisis → Rich, held 24 h with RV falling: the first sellable window
    if (s.regime === 'Rich' && s.fromCrisisAt != null && !s.firstWindowSent && now - s.fromCrisisAt >= 24 * H
      && r.rv.rv24 != null && r.rv.rv7d != null && r.rv.rv24 < r.rv.rv7d) {
      alerts.push({ kind: 'regime', title: 'First sellable window after the crisis', message: `${iv}. IV has stayed below Crisis for 24 h and RV is falling: a strangle is allowed again, at half size.` });
      s.firstWindowSent = true;
    }

    // Dead/Low for 3 weeks: compression building
    const lowish = s.regime === 'Dead' || s.regime === 'Low';
    if (lowish) {
      s.lowSince = prev.lowSince ?? now;
      if (!prev.lowAlertSent && now - s.lowSince >= 21 * DAY) {
        alerts.push({ kind: 'building', title: 'Compression building', message: `IV has been ${s.regime} for 3 weeks (${iv}). Quiet often ends in a big move either way: keep size small and set tripwires.` });
        s.lowAlertSent = true;
      }
    } else { s.lowSince = null; s.lowAlertSent = false; }
  }

  // compression level
  const lvl = r.compression.level;
  if (lvl !== prev.compression) {
    const rank = { Normal: 0, Quiet: 1, Coiled: 2, Squeeze: 3 } as const;
    const up = rank[lvl] > rank[prev.compression];
    if (lvl === 'Coiled' || lvl === 'Squeeze' || (!up && rank[prev.compression] >= 2)) {
      const message = lvl === 'Squeeze' ? `${r.compression.why}. No new strangles; on open trades, exit if price closes outside the quiet range.`
        : lvl === 'Coiled' ? `${r.compression.why}. Sell only with IV/RV ≥ 1.3 and IV percentile ≥ 40, half size, strikes near 0.10 delta.`
          : `The silence is over (${lvl}). Watch for the wake-up wave → settle → roll-over before selling.`;
      alerts.push({ kind: 'compression', title: up ? `Market ${lvl}` : `Silence broken: ${prev.compression} → ${lvl}`, message });
    }
    s.compression = lvl; s.compressionSince = now;
  }
  return { state: s, alerts };
}

// ---------------- tripwire ----------------

export interface Tripwire { hi: number; lo: number; fromMs: number; key: string; broken: 'up' | 'down' | null; close: number | null; expanding: boolean }

/**
 * The quiet range while Coiled or in a Squeeze: high and low of the hourly bars over the quiet spell (the longest
 * session run, in weekdays; at least the last 24 h). A break = an hourly close outside it while RV is expanding
 * (6 h above 24 h). Returns null when the market is not compressed.
 */
export function tripwire(r: VolRead, bars1h: readonly Bar[], now: number): Tripwire | null {
  if (r.compression.level !== 'Coiled' && r.compression.level !== 'Squeeze') return null;
  const done = bars1h.filter((b) => b.t + H <= now);
  if (done.length < 26) return null;
  const run = Math.max(1, ...r.sessions.map((x) => x.quietRun));
  const fromMs = now - Math.max(24, Math.ceil(run * 1.4) * 24) * H; // weekdays → calendar days, roughly
  const last = done.at(-1)!;
  const spell = done.filter((b) => b.t >= fromMs && b.t < last.t); // the range before the bar being tested
  if (spell.length < 12) return null;
  const hi = Math.max(...spell.map((b) => b.h)), lo = Math.min(...spell.map((b) => b.l));
  const expanding = r.rv.rv6 != null && r.rv.rv24 != null && r.rv.rv6 > r.rv.rv24;
  const broken = !expanding ? null : last.c > hi ? 'up' : last.c < lo ? 'down' : null;
  return { hi, lo, fromMs, key: `${Math.round(hi)}-${Math.round(lo)}`, broken, close: last.c, expanding };
}
