import { aggregate, atr, rsi, vwap, type Bar } from '../bot/futures.js';
import { adxLast, bollinger, changePct, edgeEstimate, emaLast, macdHist, rvPct, speedVsIv } from './conditions.js';
import { latest, valueAgo, type ClockIv, type Sample } from './series-math.js';

/**
 * "Market condition" in Ask me: one read of the whole market for a short strangle seller, built from the same indicators as the
 * entry conditions (RSI, ADX, EMA, MACD, Bollinger, ATR, VWAP, price change, speed vs IV, Edge, ATM IV, DVOL and the falling checks),
 * plus the IV and gamma picture that decides whether a strangle ends at its target or its stop. Pure: numbers in, a report out.
 * It is a read of the conditions right now, not a forecast.
 */
export type Signal = 'calm' | 'caution' | 'neutral';
export type Trend = 'bullish' | 'bearish' | 'sideways';

export interface ReportInput {
  nowMs: number;
  spot: number;
  /** Closed 5 minute candles, oldest first. */
  bars5m: readonly Bar[];
  atmIv: number | null;
  dvol: number | null;
  gateGo: boolean | null;
  gateReasons: string[];
  hist?: readonly Sample[];
  clock?: ClockIv | null;
  /** The chain's ATM row for the expiry a strangle would trade, and the two short legs the default rule would pick. */
  atm?: { expiryLabel: string; hoursLeft: number; strike: number; iv: number | null; gamma: number | null; theta: number | null; straddle: number | null } | null;
  legs?: Array<{ type: 'call' | 'put'; strike: number; delta: number; gamma: number | null; iv: number | null; price: number }> | null;
}

export interface Tile { id: string; group: 'trend' | 'strength' | 'momentum' | 'volatility' | 'iv' | 'gate'; label: string; value: string; signal: Signal; dir: -1 | 0 | 1; note: string }

export interface MarketReport {
  at: number;
  spot: number;
  trend: { label: Trend; score: number; why: string[] };
  patterns: string[];
  chart: { closes: number[]; ema20: Array<number | null>; ema50: Array<number | null>; upper: Array<number | null>; lower: Array<number | null>; vwap: number | null; stepMin: number };
  tiles: Tile[];
  counts: { calm: number; caution: number; neutral: number };
  iv: {
    atmIv: number | null; dvol: number | null; rv24: number | null; expectedRv: number | null; edge: number | null; speed60: number | null;
    sigma4hPct: number | null; sigma24hPct: number | null;
    atm: { expiryLabel: string; strike: number; gamma: number | null; theta: number | null; straddle: number | null } | null;
    legs: Array<{ type: 'call' | 'put'; strike: number; delta: number; gammaPctOfAtm: number | null; ivVsAtm: number | null; distancePct: number; sigmas24h: number | null }>;
    drivers: { target: string[]; stop: string[]; now: string };
  };
  recommendation: { verdict: 'go' | 'wait' | 'avoid'; headline: string; reasons: string[]; stopNote: string };
  summary: string;
}

const f1 = (n: number | null | undefined, d = 1): string => (n == null || !Number.isFinite(n) ? 'no data' : n.toFixed(d));
const sg = (n: number, d = 1): string => (n >= 0 ? '+' : '') + n.toFixed(d);
const closesOf = (bs: readonly Bar[]): number[] => bs.map((b) => b.c);

function emaSeriesOrNull(values: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out[i] = e; }
  return out;
}

/** Slope of a straight line through the closes, as a percent of the first close, and how well it fits (R squared). */
function lineFit(values: readonly number[]): { slopePct: number; r2: number } | null {
  const n = values.length;
  if (n < 6 || !(values[0]! > 0)) return null;
  const mx = (n - 1) / 2, my = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (values[i]! - my); sxx += (i - mx) ** 2; syy += (values[i]! - my) ** 2; }
  if (!sxx || !syy) return { slopePct: 0, r2: 0 };
  return { slopePct: ((sxy / sxx) * (n - 1) / values[0]!) * 100, r2: (sxy * sxy) / (sxx * syy) };
}

/** Plain-language patterns from the last 12 hours of 15 minute candles. */
export function detectPatterns(b15: readonly Bar[]): string[] {
  const out: string[] = [];
  const w = b15.slice(-48);
  if (w.length < 24) return out;
  const hi = Math.max(...w.map((b) => b.h)), lo = Math.min(...w.map((b) => b.l)), mid = (hi + lo) / 2;
  const rangePct = ((hi - lo) / mid) * 100;
  const last = w[w.length - 1]!, prior = w.slice(0, -1);
  const prevHi = Math.max(...prior.slice(-24).map((b) => b.h)), prevLo = Math.min(...prior.slice(-24).map((b) => b.l));
  if (last.c > prevHi) out.push(`Breakout up: the last candle closed above the 6 hour high (${prevHi.toFixed(0)}).`);
  else if (last.c < prevLo) out.push(`Breakdown: the last candle closed below the 6 hour low (${prevLo.toFixed(0)}).`);
  else if (rangePct < 1.6) out.push(`Tight range: 12 hours between ${lo.toFixed(0)} and ${hi.toFixed(0)} (${rangePct.toFixed(2)}% wide). Price is going nowhere, which is what a seller wants.`);
  const fit = lineFit(closesOf(w));
  if (fit && fit.r2 > 0.6 && fit.slopePct > 0.8) out.push(`Steady climb: about ${fit.slopePct.toFixed(1)}% higher over 12 hours in a fairly straight line.`);
  else if (fit && fit.r2 > 0.6 && fit.slopePct < -0.8) out.push(`Steady slide: about ${Math.abs(fit.slopePct).toFixed(1)}% lower over 12 hours in a fairly straight line.`);
  const closes = closesOf(b15);
  const bwAt = (end: number): number | null => { const bb = bollinger(closes.slice(0, end), 20); return bb ? (bb.upper - bb.lower) / bb.mid : null; };
  const now = bwAt(closes.length), earlier = [closes.length - 12, closes.length - 24, closes.length - 36].map(bwAt).filter((x): x is number => x != null);
  if (now != null && earlier.length && now < Math.min(...earlier) * 0.75) out.push('Volatility squeeze: the Bollinger bands are the tightest in about 9 hours. Quiet now, but a bigger move often follows a squeeze.');
  const rets = w.slice(-4).map((b) => Math.abs(b.c - b.o) / b.o * 100), avg = w.slice(0, -4).reduce((a, b) => a + Math.abs(b.c - b.o) / b.o * 100, 0) / Math.max(1, w.length - 4);
  if (avg > 0 && Math.max(...rets) > avg * 4) out.push('A sudden spike candle in the last hour, several times the usual size: let it settle before selling.');
  return out;
}

export function buildMarketReport(i: ReportInput): MarketReport {
  const b5 = i.bars5m, b15 = aggregate(b5, 15), b1h = aggregate(b5, 60);
  const c15 = closesOf(b15), c1h = closesOf(b1h);
  const tiles: Tile[] = [];
  const add = (t: Tile) => tiles.push(t);
  const spot = i.spot;

  // ---- trend: which way, from the moving averages, MACD, VWAP and the recent move
  const e9 = emaLast(c15, 9), e21 = emaLast(c15, 21), e20h = emaLast(c1h, 20), e50h = emaLast(c1h, 50);
  // a direction only counts when the gap is big enough to mean something: in a dead-flat market a 10 point EMA gap is noise, not a trend
  const gapDir = (fast: number, slow: number, minPct: number): -1 | 0 | 1 => { const g = ((fast - slow) / slow) * 100; return g > minPct ? 1 : g < -minPct ? -1 : 0; };
  const word = (d: number, up: string, down: string): string => (d === 1 ? up : d === -1 ? down : 'flat: no real gap');
  if (e9 != null && e21 != null) { const d = gapDir(e9, e21, 0.03); add({ id: 'ema15', group: 'trend', label: 'EMA 9 / 21 (15m)', value: word(d, 'fast above slow', 'fast below slow'), signal: 'neutral', dir: d, note: `${e9.toFixed(0)} vs ${e21.toFixed(0)}` }); }
  if (e20h != null && e50h != null) { const d = gapDir(e20h, e50h, 0.05); add({ id: 'ema1h', group: 'trend', label: 'EMA 20 / 50 (1h)', value: word(d, 'fast above slow', 'fast below slow'), signal: 'neutral', dir: d, note: `${e20h.toFixed(0)} vs ${e50h.toFixed(0)}` }); }
  for (const [tf, cl] of [['15m', c15], ['1h', c1h]] as const) {
    const h = macdHist(cl);
    if (h != null) { const d: -1 | 0 | 1 = (Math.abs(h) / spot) * 100 < 0.01 ? 0 : h > 0 ? 1 : -1; add({ id: `macd${tf}`, group: 'trend', label: `MACD (${tf})`, value: word(d, 'bullish', 'bearish'), signal: 'neutral', dir: d, note: `histogram ${f1(h)}` }); }
  }
  const vw = vwap(b5.slice(-288));
  if (vw != null) { const d = gapDir(spot, vw, 0.08); add({ id: 'vwap', group: 'trend', label: 'VWAP (24h)', value: word(d, 'price above', 'price below'), signal: 'neutral', dir: d, note: `${spot.toFixed(0)} vs ${vw.toFixed(0)}` }); }
  for (const [m, name] of [[60, '1h'], [240, '4h']] as const) {
    const ch = changePct(b5, m);
    if (ch != null) add({ id: `chg${m}`, group: 'trend', label: `Price change (${name})`, value: `${sg(ch, 2)}%`, signal: Math.abs(ch) < (m === 60 ? 0.6 : 1.2) ? 'calm' : 'caution', dir: ch > (m === 60 ? 0.3 : 0.6) ? 1 : ch < -(m === 60 ? 0.3 : 0.6) ? -1 : 0, note: Math.abs(ch) < (m === 60 ? 0.6 : 1.2) ? 'a small move' : 'a big move for a seller' });
  }

  // ---- strength: is it trending at all (this hurts a seller whichever way it goes)
  const adx15 = adxLast(b15), adx1h = adxLast(b1h);
  for (const [tf, a] of [['15m', adx15], ['1h', adx1h]] as const) {
    if (a != null) add({ id: `adx${tf}`, group: 'strength', label: `ADX (${tf})`, value: a.toFixed(1), signal: a < 20 ? 'calm' : a > 25 ? 'caution' : 'neutral', dir: 0, note: a < 20 ? 'no trend: a range' : a > 25 ? 'a trend is running' : 'a weak trend' });
  }
  const adxPrev = adxLast(b15.slice(0, -3));
  if (adx15 != null && adxPrev != null) add({ id: 'adxfall', group: 'strength', label: 'ADX falling (15m)', value: adx15 < adxPrev ? `down from ${adxPrev.toFixed(1)}` : `up from ${adxPrev.toFixed(1)}`, signal: adx15 < adxPrev && adx15 < 25 ? 'calm' : adx15 > adxPrev && adx15 > 25 ? 'caution' : 'neutral', dir: 0, note: 'a trend that is fading helps a seller' });

  // ---- momentum
  for (const [tf, cl] of [['15m', c15], ['1h', c1h]] as const) {
    const r = rsi(cl, 14);
    if (r != null) add({ id: `rsi${tf}`, group: 'momentum', label: `RSI (${tf})`, value: r.toFixed(1), signal: r >= 40 && r <= 60 ? 'calm' : r < 30 || r > 70 ? 'caution' : 'neutral', dir: r > 56 ? 1 : r < 44 ? -1 : 0, note: r > 70 ? 'overbought' : r < 30 ? 'oversold' : r >= 40 && r <= 60 ? 'balanced' : 'leaning' });
  }
  const rsiNow = rsi(c15, 14), rsiPrev = rsi(c15.slice(0, -3), 14);
  if (rsiNow != null && rsiPrev != null) add({ id: 'rsifall', group: 'momentum', label: 'RSI direction (15m)', value: `${rsiNow.toFixed(1)}, was ${rsiPrev.toFixed(1)}`, signal: 'neutral', dir: 0, note: rsiNow < rsiPrev ? 'cooling' : 'warming' });

  // ---- volatility of price
  const a1h = atr(b1h, 14), last1h = b1h[b1h.length - 1]?.c;
  if (a1h != null && last1h) { const p = (a1h / last1h) * 100; add({ id: 'atr', group: 'volatility', label: 'ATR (1h)', value: `${p.toFixed(2)}% of price`, signal: p < 0.35 ? 'calm' : p > 0.6 ? 'caution' : 'neutral', dir: 0, note: p < 0.35 ? 'small candles' : p > 0.6 ? 'large candles' : 'normal candles' }); }
  for (const [tf, cl] of [['15m', c15], ['1h', c1h]] as const) {
    const bb = bollinger(cl, 20), last = cl[cl.length - 1];
    if (bb && last != null) { const inside = last <= bb.upper && last >= bb.lower; add({ id: `bb${tf}`, group: 'volatility', label: `Bollinger (${tf})`, value: inside ? 'inside the bands' : last > bb.upper ? 'above the upper band' : 'below the lower band', signal: inside ? 'calm' : 'caution', dir: 0, note: `bands ${bb.lower.toFixed(0)} to ${bb.upper.toFixed(0)}` }); }
  }
  const rv1 = rvPct(b5, 12), rv1prev = rvPct(b5, 12, 12);
  if (rv1 != null && rv1prev != null) add({ id: 'rvfall', group: 'volatility', label: 'Realised vol (last hour)', value: `${rv1.toFixed(1)}, before ${rv1prev.toFixed(1)}`, signal: rv1 <= rv1prev * 0.95 ? 'calm' : rv1 > rv1prev * 1.2 ? 'caution' : 'neutral', dir: 0, note: rv1 <= rv1prev * 0.95 ? 'falling' : rv1 > rv1prev * 1.2 ? 'rising' : 'steady' });
  const sp = speedVsIv(b5, i.atmIv, 60);
  if (sp != null) add({ id: 'speed', group: 'volatility', label: 'Speed vs IV (1h)', value: `${sp.toFixed(2)}x implied`, signal: sp < 0.8 ? 'calm' : sp > 1.3 ? 'caution' : 'neutral', dir: 0, note: sp < 0.8 ? 'price is moving slower than IV prices' : sp > 1.3 ? 'price is moving faster than IV prices: gamma hurts sellers' : 'about as fast as IV prices' });

  // ---- implied volatility
  const e = edgeEstimate(b5, i.atmIv);
  if (i.atmIv != null) add({ id: 'atmiv', group: 'iv', label: 'ATM IV', value: i.atmIv.toFixed(1), signal: 'neutral', dir: 0, note: 'what the options market charges' });
  if (i.dvol != null) add({ id: 'dvol', group: 'iv', label: 'DVOL', value: i.dvol.toFixed(1), signal: 'neutral', dir: 0, note: 'Deribit 30 day volatility index' });
  if (e) add({ id: 'edge', group: 'iv', label: 'Edge (IV minus expected RV)', value: `${sg(e.edge)} pts`, signal: e.edge >= 3 ? 'calm' : e.edge < 0 ? 'caution' : 'neutral', dir: 0, note: e.edge >= 3 ? 'options are priced richer than the market moves' : e.edge < 0 ? 'the market moves more than the options charge' : 'a thin edge' });
  const hist = i.hist ?? [];
  const ivNow = latest(hist, 'atmIv'), iv60 = valueAgo(hist, 'atmIv', i.nowMs, 60);
  if (ivNow != null && iv60 != null) add({ id: 'ivfall', group: 'iv', label: 'ATM IV over 60 min', value: `${ivNow.toFixed(1)}, ${iv60.toFixed(1)} an hour ago`, signal: ivNow <= iv60 - 0.2 ? 'calm' : ivNow >= iv60 + 0.8 ? 'caution' : 'neutral', dir: 0, note: ivNow <= iv60 - 0.2 ? 'IV is falling: good for a seller' : ivNow >= iv60 + 0.8 ? 'IV is rising: sold legs gain value even if price is flat' : 'IV is flat' });
  const dvNow = i.dvol ?? latest(hist, 'dvol'), dv60 = valueAgo(hist, 'dvol', i.nowMs, 60);
  if (dvNow != null && dv60 != null) add({ id: 'dvfall', group: 'iv', label: 'DVOL over 60 min', value: `${dvNow.toFixed(1)}, ${dv60.toFixed(1)} an hour ago`, signal: dvNow <= dv60 - 0.2 ? 'calm' : dvNow >= dv60 + 0.8 ? 'caution' : 'neutral', dir: 0, note: dvNow <= dv60 - 0.2 ? 'falling' : dvNow >= dv60 + 0.8 ? 'rising' : 'flat' });
  const ck = i.clock, cur = ck ? (ck.source === 'ATM IV' ? i.atmIv : i.dvol) : null;
  if (ck && cur != null) { const d = cur - ck.value; add({ id: 'ivclock', group: 'iv', label: 'IV vs its usual clock path', value: `${sg(d)} pt vs usual ${ck.value.toFixed(1)}`, signal: d <= -1 ? 'calm' : d >= 2 ? 'caution' : 'neutral', dir: 0, note: `${ck.source}, average of ${ck.days} days at this time` }); }

  // ---- the desk's own gate
  add({ id: 'gate', group: 'gate', label: 'Desk gate', value: i.gateGo == null ? 'no data' : i.gateGo ? 'GO' : 'WAIT', signal: i.gateGo == null ? 'neutral' : i.gateGo ? 'calm' : 'caution', dir: 0, note: i.gateGo === false ? i.gateReasons.join('; ') || 'not clear' : i.gateGo ? 'the desk gate is clear' : 'no reading' });

  // ---- direction
  const votes = tiles.filter((t) => t.group === 'trend' || t.group === 'momentum');
  const dirTiles = votes.filter((t) => t.dir !== 0 || t.group === 'trend');
  const score = dirTiles.length ? Math.round((dirTiles.reduce((a, t) => a + t.dir, 0) / dirTiles.length) * 100) : 0;
  // bullish or bearish needs a real trend (ADX) behind the direction; without one it is sideways however the small gaps lean
  const trending = adx1h != null || adx15 != null ? (adx1h ?? 0) >= 22 || (adx15 ?? 0) >= 25 : Math.abs(score) >= 60;
  const label: Trend = score >= 40 && trending ? 'bullish' : score <= -40 && trending ? 'bearish' : 'sideways';
  const why: string[] = [];
  const up = dirTiles.filter((t) => t.dir === 1).map((t) => t.label), dn = dirTiles.filter((t) => t.dir === -1).map((t) => t.label);
  if (up.length) why.push(`Pointing up: ${up.join(', ')}.`);
  if (dn.length) why.push(`Pointing down: ${dn.join(', ')}.`);
  why.push(adx1h != null || adx15 != null ? `Trend strength (ADX) is ${f1(adx1h ?? adx15)}: ${((adx1h ?? adx15)!) < 20 ? 'no real trend.' : ((adx1h ?? adx15)!) > 25 ? 'a trend is running.' : 'a weak trend.'}` : 'Not enough candles for trend strength.');

  // ---- the pictures
  const nShow = 64;
  const show = b15.slice(-nShow), off = c15.length - show.length;
  const e20s = emaSeriesOrNull(c15, 20).slice(off), e50s = emaSeriesOrNull(c15, 50).slice(off);
  const bands = show.map((_, k) => { const idx = off + k + 1; const bb = bollinger(c15.slice(0, idx), 20); return bb ? { u: bb.upper, l: bb.lower } : null; });
  const chart: MarketReport['chart'] = { closes: show.map((b) => b.c), ema20: e20s, ema50: e50s, upper: bands.map((x) => x?.u ?? null), lower: bands.map((x) => x?.l ?? null), vwap: vw, stepMin: 15 };

  // ---- IV and gamma: what ends a short strangle at its target or at its stop
  const sigma = (hours: number): number | null => (i.atmIv ? spot * (i.atmIv / 100) * Math.sqrt(hours / (365 * 24)) : null);
  const s4 = sigma(4), s24 = sigma(24);
  const atm = i.atm ?? null;
  const legs = (i.legs ?? []).map((l) => ({
    type: l.type, strike: l.strike, delta: l.delta,
    gammaPctOfAtm: l.gamma != null && atm?.gamma ? (l.gamma / atm.gamma) * 100 : null,
    ivVsAtm: l.iv != null && atm?.iv != null ? l.iv - atm.iv : null,
    distancePct: ((l.strike - spot) / spot) * 100,
    sigmas24h: s24 ? Math.abs(l.strike - spot) / s24 : null,
  }));
  const target: string[] = [], stop: string[] = [];
  target.push('Time decay (theta) and falling IV pay a seller. The trade reaches its target when price stays between the two strikes while time passes.');
  stop.push('Gamma loss: when price moves faster than the IV charged for, the sold leg on that side gains value faster than decay pays. A fast move through a strike is what hits the stop.');
  stop.push('Rising IV: even with flat price, the sold legs gain value when IV rises, which can hit a stop without any price move.');
  let now = 'Not enough data to compare implied and realised volatility yet.';
  if (e) {
    now = e.edge >= 3
      ? `Right now implied vol (${i.atmIv!.toFixed(1)}) is ${e.edge.toFixed(1)} points above the vol the market has actually delivered (${e.expected.toFixed(1)}), so decay is winning over gamma: the setup favours the target.`
      : e.edge < 0
        ? `Right now implied vol (${i.atmIv!.toFixed(1)}) is ${Math.abs(e.edge).toFixed(1)} points BELOW the vol the market has delivered (${e.expected.toFixed(1)}), so gamma is winning over decay: the setup favours the stop.`
        : `Right now implied vol (${i.atmIv!.toFixed(1)}) is only ${e.edge.toFixed(1)} points above delivered vol (${e.expected.toFixed(1)}): decay and gamma are close to even, so the edge is thin.`;
    if (sp != null) now += ` Price has moved ${sp.toFixed(2)}x what IV implies over the last hour${sp > 1.3 ? ', which is the gamma-loss zone.' : '.'}`;
  }
  if (legs.length) {
    const near = legs.reduce((a, b) => ((a.sigmas24h ?? 9) < (b.sigmas24h ?? 9) ? a : b));
    if (near.sigmas24h != null) now += ` The nearest short strike (${near.type} ${near.strike}) is ${Math.abs(near.distancePct).toFixed(1)}% away, about ${near.sigmas24h.toFixed(1)} one-day standard moves.`;
  }

  // ---- the verdict
  const calm = tiles.filter((t) => t.signal === 'calm').length, caution = tiles.filter((t) => t.signal === 'caution').length, neutral = tiles.length - calm - caution;
  const hard: string[] = [];
  if (i.gateGo === false) hard.push(`The desk gate says WAIT (${i.gateReasons.join('; ') || 'not clear'}).`);
  if (label !== 'sideways') hard.push(`The market is ${label} with trend strength ${f1(adx1h ?? adx15)}: sellers get hurt in a trend.`);
  if (sp != null && sp > 1.3) hard.push(`Price is moving ${sp.toFixed(2)}x faster than IV prices.`);
  if (e && e.edge < 0) hard.push(`Edge is negative (${sg(e.edge)}): the market moves more than the options charge.`);
  const share = tiles.length ? calm / Math.max(1, calm + caution) : 0;
  // less than about a day of candles: the trend and strength indicators have nothing to read, so it can never be a GO
  const thin = b5.length < 300;
  const verdict: 'go' | 'wait' | 'avoid' = thin ? 'wait' : hard.length >= 2 || (caution >= 2 * Math.max(1, calm) && caution >= 5) ? 'avoid' : hard.length === 0 && share >= 0.6 && tiles.length >= 8 ? 'go' : 'wait';
  const reasons: string[] = [];
  if (verdict === 'go') reasons.push(`${calm} of ${calm + caution} reading indicators are calm for a seller and none of the hard blockers is on.`);
  reasons.push(...hard);
  const calmNames = tiles.filter((t) => t.signal === 'calm').slice(0, 4).map((t) => t.label);
  if (calmNames.length && verdict !== 'go') reasons.push(`In its favour: ${calmNames.join(', ')}.`);
  if (thin) reasons.unshift(`There are not enough candles yet to read the indicators (${b5.length} of the 300 needed, about a day of 5 minute candles).`);
  const headline = verdict === 'go' ? 'Suitable for a short strangle now' : verdict === 'wait' ? 'Not yet: better to wait' : 'Avoid a short strangle now';
  const stopNote = verdict === 'go' ? 'If you sell: a 2x stop on each sold leg, and close everything when one leg stops.' : verdict === 'wait' ? 'If you sell anyway, keep the 2x stops and size small. Better: wait for the cautions to clear.' : 'Selling into this is how stops get hit. Stay out until the blockers clear.';

  const trendWord = label === 'sideways' ? 'sideways' : label;
  const summary = `BTC is ${trendWord} at ${spot.toFixed(0)} (direction score ${sg(score, 0)}). ${calm} indicators are calm for a seller, ${caution} call for caution and ${neutral} are neutral. ${e ? `Implied vol ${i.atmIv!.toFixed(1)} against expected realised ${e.expected.toFixed(1)} is an edge of ${sg(e.edge)}. ` : ''}Verdict: ${headline.toLowerCase()}.`;

  return {
    at: i.nowMs, spot, trend: { label, score, why }, patterns: detectPatterns(b15), chart, tiles, counts: { calm, caution, neutral },
    iv: {
      atmIv: i.atmIv, dvol: i.dvol, rv24: rvPct(b5, 288), expectedRv: e?.expected ?? null, edge: e?.edge ?? null, speed60: sp,
      sigma4hPct: s4 != null ? (s4 / spot) * 100 : null, sigma24hPct: s24 != null ? (s24 / spot) * 100 : null,
      atm: atm ? { expiryLabel: atm.expiryLabel, strike: atm.strike, gamma: atm.gamma, theta: atm.theta, straddle: atm.straddle } : null,
      legs, drivers: { target, stop, now },
    },
    recommendation: { verdict, headline, reasons, stopNote }, summary,
  };
}
