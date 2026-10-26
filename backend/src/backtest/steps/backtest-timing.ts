/**
 * Short strangle timing study on REAL Delta Exchange India option mark prices (15 minute candles).
 *
 *   npx tsx src/backtest/steps/backtest-timing.ts
 *
 * For every expiry on file, every 15 minute entry slot of the 24 hours in which that expiry is the third listed one (2DTE),
 * every target delta 0.10 .. 0.15 (both legs picked from the real strikes by Black-Scholes delta at the implied vol of that
 * strike's own mark) and every hold length 1h .. 23h (30 minute steps):
 *   - sell the call and the put at the mark (less half a spread when the scenario has one)
 *   - each leg stops at 2x its sold premium (mark HIGH of any 15 minute bar), one leg stopping closes both
 *   - the position also closes when net profit reaches 10% of the portfolio margin (bar close)
 *   - otherwise it closes at the hold time
 *   - Delta fee + GST on every fill
 * The path of each (expiry, entry, delta) is walked once and every hold length is read from it.
 *
 * Output: output/timing_<spread>.json (tensor summary) used by timing-report.ts. Nothing here is modelled except the
 * Black-Scholes delta used to PICK strikes and the margin; every price is a recorded Delta mark.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bs, bsDelta } from '../lib/pricing.js';
import { portfolioMargin } from '../../lib/bot/portfolio-margin.js';
import { optionFee } from '../../lib/bot/costs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, '../data/cache');
const OUT = path.resolve(here, '../output');
fs.mkdirSync(OUT, { recursive: true });

export const DELTAS = [0.10, 0.11, 0.12, 0.13, 0.14, 0.15];
export const HOLD_BARS: number[] = []; // in 15 minute bars: 1h .. 23h every 30 minutes
for (let k = 4; k <= 92; k += 2) HOLD_BARS.push(k);
const LOTS = 100, CV = 0.001, YEAR_MS = 365 * 86_400_000, DAYMS = 86_400_000;
const TP_FRAC = Number(process.env.TP_FRAC ?? 0.10);
const STOP_MULT = Number(process.env.STOP_MULT ?? 2);
const FEE_RATE = 0.0003, FEE_CAP = 0.1;

interface Row { s: string; k: number; t: string; t0: number; o: number[]; h: number[]; l: number[]; c: number[] }
const at = (a: number[], i: number): number | null => { const v = a[i]; return v == null || !Number.isFinite(v) ? null : v; };

function spotBook() {
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
  const m = new Map<number, number>();
  for (const r of raw) m.set(r[0]!, r[1]!);
  return (sec: number) => m.get(Math.floor(sec / 900) * 900) ?? null;
}

function impliedVol(price: number, S: number, K: number, T: number, cp: 'c' | 'p'): number | null {
  const intrinsic = cp === 'c' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (price <= intrinsic + 0.01) return null;
  let lo = 1, hi = 400;
  if (bs(S, K, T, hi, cp) < price) return null;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (bs(S, K, T, mid, cp) < price) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

export interface Tensor {
  spread: number;
  slots: number; deltas: number[]; holds: number[];
  /** [expiry] entry time (seconds) of slot 0 */
  expiries: number[];
  /** ret[(slot*ND+di)*NH+hi][expiryIdx] = net profit as a fraction of margin, NaN when no trade */
  ret: Float32Array[]; why: Uint8Array[];
  /** per expiry x slot: entry spot, mean IV of the two legs, margin per 100 lots (USD) */
  spot: Float32Array; iv: Float32Array; margin: Float32Array;
}

export function simulate(spread: number): Tensor {
  const files = fs.readdirSync(path.join(CACHE, 'delta')).filter((f) => /^x-\d{8}\.json$/.test(f)).sort();
  const spotAt = spotBook();
  const ND = DELTAS.length, NH = HOLD_BARS.length, NS = 96, NE = files.length;
  const ret: Float32Array[] = [], why: Uint8Array[] = [];
  for (let i = 0; i < NS * ND * NH; i++) { ret.push(new Float32Array(NE).fill(NaN)); why.push(new Uint8Array(NE)); }
  const spotArr = new Float32Array(NE * NS).fill(NaN), ivArr = new Float32Array(NE * NS).fill(NaN), marArr = new Float32Array(NE * NS).fill(NaN);
  const expiries: number[] = [];
  const MAXB = Math.max(...HOLD_BARS);

  files.forEach((f, ei) => {
    const { ex, rows } = JSON.parse(fs.readFileSync(path.join(CACHE, 'delta', f), 'utf8')) as { ex: number; rows: Row[] };
    expiries.push(ex);
    const exSec = ex / 1000;
    const calls = rows.filter((r) => r.t === 'C').sort((a, b) => a.k - b.k), puts = rows.filter((r) => r.t === 'P').sort((a, b) => a.k - b.k);
    for (let slot = 0; slot < NS; slot++) {
      const tSec = exSec - 3 * 86400 - 3600 + (slot + 1) * 900; // (E-3d-1h, E-2d-1h]
      const S = spotAt(tSec);
      if (S == null) continue;
      const T = (exSec - tSec) * 1000 / YEAR_MS;
      // candidates: strikes out of the money, with the mark at the entry bar and the delta that mark implies
      type Cand = { r: Row; iv: number; d: number; idx: number; p0: number };
      const cand = (list: Row[], cp: 'c' | 'p'): Cand[] => {
        const out: Cand[] = [];
        for (const r of list) {
          if (cp === 'c' ? r.k <= S : r.k >= S) continue;
          const idx = Math.round((tSec - r.t0) / 900);
          if (idx < 0) continue;
          const p0 = at(r.o, idx);
          if (p0 == null || p0 < 1) continue;
          const iv = impliedVol(p0, S, r.k, T, cp);
          if (iv == null) continue;
          out.push({ r, iv, d: Math.abs(bsDelta(S, r.k, T, iv, cp)), idx, p0 });
        }
        return out;
      };
      const cc = cand(calls, 'c'), pc = cand(puts, 'p');
      if (!cc.length || !pc.length) continue;
      for (let di = 0; di < ND; di++) {
        const tgt = DELTAS[di]!;
        const pick = (cs: Cand[]) => cs.reduce((b, x) => (Math.abs(x.d - tgt) < Math.abs(b.d - tgt) ? x : b));
        const C = pick(cc), P = pick(pc);
        if (Math.abs(C.d - tgt) > 0.04 || Math.abs(P.d - tgt) > 0.04) continue;
        const sellC = C.p0 * (1 - spread), sellP = P.p0 * (1 - spread);
        const mar = portfolioMargin([
          { type: 'call', side: 'short', strike: C.r.k, expiryMs: ex, lots: LOTS, iv: C.iv },
          { type: 'put', side: 'short', strike: P.r.k, expiryMs: ex, lots: LOTS, iv: P.iv },
        ], S, tSec * 1000, CV).margin;
        if (!(mar > 0)) continue;
        if (di === 0 || true) { const si = ei * NS + slot; if (Number.isNaN(spotArr[si]!)) { spotArr[si] = S; } }
        ivArr[ei * NS + slot] = ivArr[ei * NS + slot]! > 0 ? ivArr[ei * NS + slot]! : (C.iv + P.iv) / 2;
        marArr[ei * NS + slot] = marArr[ei * NS + slot]! > 0 ? marArr[ei * NS + slot]! : mar;
        const feeIn = optionFee({ price: C.p0, lots: LOTS, contractValue: CV, spot: S, rate: FEE_RATE, premiumCapRate: FEE_CAP }) + optionFee({ price: P.p0, lots: LOTS, contractValue: CV, spot: S, rate: FEE_RATE, premiumCapRate: FEE_CAP });
        const lvC = STOP_MULT * sellC, lvP = STOP_MULT * sellP;
        const usd = (sold: number, buy: number) => (sold - buy) * LOTS * CV;
        const feeOut = (pc2: number, pp2: number) => optionFee({ price: pc2, lots: LOTS, contractValue: CV, spot: S, rate: FEE_RATE, premiumCapRate: FEE_CAP }) + optionFee({ price: pp2, lots: LOTS, contractValue: CV, spot: S, rate: FEE_RATE, premiumCapRate: FEE_CAP });
        const target = TP_FRAC * mar;
        // walk the path once: first stop bar and first take-profit bar
        let stopBar = -1, tpBar = -1, stopPnl = 0, tpPnl = 0, gaps = false;
        const cl = (r: Row, b: number, a: number[], fallback: number) => at(a, b) ?? fallback;
        let lastC = C.p0, lastP = P.p0;
        const lim = Math.min(MAXB, C.r.o.length - C.idx, P.r.o.length - P.idx);
        for (let j = 0; j < lim; j++) {
          const hc = at(C.r.h, C.idx + j), hp = at(P.r.h, P.idx + j);
          const ccl = cl(C.r, C.idx + j, C.r.c, lastC), pcl = cl(P.r, P.idx + j, P.r.c, lastP);
          if (at(C.r.c, C.idx + j) == null || at(P.r.c, P.idx + j) == null) gaps = true;
          lastC = ccl; lastP = pcl;
          const stopC = hc != null && hc >= lvC, stopP = hp != null && hp >= lvP;
          if (stopC || stopP) {
            const bc = stopC ? lvC * (1 + spread) : ccl * (1 + spread);
            const bp = stopP ? lvP * (1 + spread) : pcl * (1 + spread);
            stopBar = j; stopPnl = usd(sellC, bc) + usd(sellP, bp) - feeIn - feeOut(bc, bp);
            break;
          }
          const bc = ccl * (1 + spread), bp = pcl * (1 + spread);
          const pnl = usd(sellC, bc) + usd(sellP, bp) - feeIn - feeOut(bc, bp);
          if (tpBar < 0 && pnl >= target) { tpBar = j; tpPnl = pnl; break; }
        }
        // every hold length from that path
        for (let hi = 0; hi < NH; hi++) {
          const k = HOLD_BARS[hi]!;
          let pnl: number, w: number;
          if (stopBar >= 0 && stopBar < k) { pnl = stopPnl; w = 1; }
          else if (tpBar >= 0 && tpBar < k) { pnl = tpPnl; w = 2; }
          else {
            if (k > lim) continue;
            const oc = at(C.r.o, C.idx + k) ?? at(C.r.c, C.idx + k - 1), op = at(P.r.o, P.idx + k) ?? at(P.r.c, P.idx + k - 1);
            if (oc == null || op == null) continue;
            const bc = oc * (1 + spread), bp = op * (1 + spread);
            pnl = usd(sellC, bc) + usd(sellP, bp) - feeIn - feeOut(bc, bp); w = 0;
          }
          const key = (slot * ND + di) * NH + hi;
          ret[key]![ei] = pnl / mar; why[key]![ei] = w;
        }
        void gaps;
      }
    }
    if (ei % 25 === 0) console.log(`  spread ${spread}: ${ei + 1}/${NE} expiries`);
  });
  return { spread, slots: NS, deltas: DELTAS, holds: HOLD_BARS, expiries, ret, why, spot: spotArr, iv: ivArr, margin: marArr };
}

/** compact save so the report step does not re-simulate */
export function saveTensor(t: Tensor, file: string) {
  const buf = Buffer.concat([
    Buffer.from(JSON.stringify({ spread: t.spread, slots: t.slots, deltas: t.deltas, holds: t.holds, expiries: t.expiries, n: t.ret.length }) + '\n'),
    ...t.ret.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)),
    ...t.why.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)),
    Buffer.from(t.spot.buffer), Buffer.from(t.iv.buffer), Buffer.from(t.margin.buffer),
  ]);
  fs.writeFileSync(file, buf);
}

export function loadTensor(file: string): Tensor {
  const buf = fs.readFileSync(file);
  const nl = buf.indexOf(10);
  const head = JSON.parse(buf.subarray(0, nl).toString('utf8'));
  const NE = head.expiries.length, n = head.n;
  let off = nl + 1;
  const take = (bytes: number) => { const b = buf.subarray(off, off + bytes); off += bytes; return b; };
  const ret: Float32Array[] = [], why: Uint8Array[] = [];
  for (let i = 0; i < n; i++) { const b = take(NE * 4); ret.push(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  for (let i = 0; i < n; i++) { const b = take(NE); why.push(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))); }
  const f = (len: number) => { const b = take(len * 4); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const m = NE * head.slots;
  return { ...head, ret, why, spot: f(m), iv: f(m), margin: f(m) };
}

if (process.argv[1] && process.argv[1].endsWith('backtest-timing.ts')) {
  const spreads = (process.env.SPREADS ?? '0,0.02,0.04').split(',').map(Number);
  for (const sp of spreads) {
    const t0 = Date.now();
    const t = simulate(sp);
    saveTensor(t, path.join(OUT, `timing_${Math.round(sp * 100)}.bin`));
    console.log(`spread ${sp}: ${t.expiries.length} expiries in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
void DAYMS;
