/**
 * Links the N2N IV path to the stop-loss rate of a real short strangle, using Delta India MARK candles of the expired daily options.
 *
 *   node n2n_stoploss.mjs            # fetch (cached in n2n_sl_cache.json) + analyse
 *   NOFETCH=1 node n2n_stoploss.mjs
 *
 * Trade tested: entry 22:30 IST on the N2N daily (expiry D+3, 12:00 UTC), sell the ~0.10-delta call and put (strikes on Delta's 200 grid,
 * delta from the ATM straddle IV), exit 07:30 IST. A leg is stopped when its 5-minute MARK high reaches STOP x its entry mark
 * (filled at exactly STOP x; no slippage, no fees). P&L is per leg in mark USD, shown as % of the credit.
 * Needs n2n_iv_cache.json from n2n_iv_nightpath.mjs (IV paths).
 */
import fs from 'node:fs';

const B = 'https://api.india.delta.exchange';
const IVC = JSON.parse(fs.readFileSync(new URL('./n2n_iv_cache.json', import.meta.url), 'utf8'));
const CACHE = new URL('./n2n_sl_cache.json', import.meta.url);
const spots = JSON.parse(fs.readFileSync(new URL('./btc-1h-5y.json', import.meta.url), 'utf8'));
const spotAt = new Map(spots.map(r => [r[0], r[3]])), hiAt = new Map(spots.map(r => [r[0], r[1]])), loAt = new Map(spots.map(r => [r[0], r[2]]));
const H = 3600000, D1 = 86400000, M5 = 300000;
const ds = ms => { const d = new Date(ms); return String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCFullYear() % 100); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
const b76 = (F, K, T, s, call) => { const sd = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd; return call ? F * N(d1) - K * N(d2) : K * N(-d2) - F * N(-d1); };
const legIv = (P, F, K, T, call) => { if (!(P > 0) || !(T > 0)) return null; let lo = 0.01, hi = 5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (b76(F, K, T, m, call) > P) ? hi = m : lo = m; } return (lo + hi) / 2; };
const straddleIv = (C, P, F, K, T) => { const tot = C + P; if (!(tot > 0) || !(T > 0)) return null; let lo = 0.01, hi = 5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (b76(F, K, T, m, true) + b76(F, K, T, m, false) > tot) ? hi = m : lo = m; } return (lo + hi) / 2; };
const deltaOf = (F, K, T, s, call) => { const sd = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd; return call ? N(d1) : N(d1) - 1; };

async function candles(sym, a, b, res) {
  const u = `${B}/v2/history/candles?resolution=${res}&symbol=${encodeURIComponent(sym)}&start=${Math.floor(a / 1000)}&end=${Math.floor(b / 1000)}`;
  for (let k = 0; k < 6; k++) { try { const r = await fetch(u); if (r.status === 429) { await sleep(800 * (k + 1)); continue; } const j = await r.json(); return (j.result || []).map(c => ({ t: c.time * 1000, o: +c.open, h: +c.high, l: +c.low, c: +c.close })); } catch (e) { await sleep(500 * (k + 1)); } }
  return null;
}
async function pickLeg(call, target, e2, a, b) {      // nearest listed strike to the target on the 200 grid that has marks over the night
  const base = Math.round(target / 200) * 200;
  const offs = []; for (let o = 0; o <= 2400; o += 200) { offs.push(o); if (o) offs.push(-o); }
  for (const off of offs) {
    const K = base + off; if (K <= 0) continue; const c = await candles(`MARK:${call ? 'C' : 'P'}-BTC-${K}-${ds(e2)}`, a, b, '5m');
    if (c && c.length > 30 && c.some(b => b.t >= a && b.t <= a + 30 * 60000)) return { K, c };
  } return null;
}
async function fetchNight(n) {
  const d = n.d, e2 = n.e2, F0 = spotAt.get(d + 16 * H), t0 = d + 17 * H, T0 = (e2 - t0) / (365 * D1);
  const ra = n.B.find(x => x[0] === d + 16 * H); if (!ra || !F0) return null; const ivA = straddleIv(ra[1], ra[2], F0, n.K2, T0); if (!ivA) return null;
  const z = 1.2816, sdv = ivA * Math.sqrt(T0), kc = F0 * Math.exp(z * sdv + 0.5 * ivA * ivA * T0), kp = F0 * Math.exp(-z * sdv + 0.5 * ivA * ivA * T0);
  const a = t0, b = d + D1 + 2 * H + M5;
  const [c, p] = await Promise.all([pickLeg(true, kc, e2, a, b), pickLeg(false, kp, e2, a, b)]); if (!c || !p) return null;
  return { d, e2, F0, ivA, c, p };
}

let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { }
if (!process.env.NOFETCH) {
  const todo = Object.keys(IVC).filter(k => IVC[k] && !(k in cache)).map(Number); console.log('to fetch', todo.length); let done = 0;
  const worker = async () => { while (todo.length) { const d = todo.shift(); try { cache[d] = await fetchNight(IVC[d]); } catch (e) { cache[d] = null; } if (++done % 40 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log('  ', done); } } };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]); fs.writeFileSync(CACHE, JSON.stringify(cache));
}

// ---------- simulate ----------
const nights = [];
for (const k of Object.keys(cache)) {
  const n = cache[k]; if (!n) continue; const iv = IVC[k]; const t0 = n.d + 17 * H, tEnd = n.d + D1 + 2 * H;
  const ent = leg => { const b = leg.c.find(x => x.t >= t0 && x.t <= t0 + 30 * 60000); return b ? b.o : null; };
  const ec = ent(n.c), ep = ent(n.p); if (!(ec > 0) || !(ep > 0)) continue;
  nights.push({ n, k: +k, ec, ep, wd: new Date(n.d).getUTCDay(), iv });
}
function run(x, mult, priceStopPct) {   // returns {pnl, stops:[{leg,t}], credit}
  const { n, ec, ep } = x, t0 = n.d + 17 * H, tEnd = n.d + D1 + 2 * H; let pnl = 0; const stops = [];
  for (const [leg, e, call] of [[n.c, ec, true], [n.p, ep, false]]) {
    let exit = null, st = null;
    for (const b of leg.c) {
      if (b.t < t0 || b.t >= tEnd) continue;
      if (mult && b.h >= mult * e) { exit = mult * e; st = b.t; break; }
      if (priceStopPct) { const hr = Math.floor(b.t / H) * H, F0 = n.F0; const hit = call ? hiAt.get(hr) >= F0 * (1 + priceStopPct) : loAt.get(hr) <= F0 * (1 - priceStopPct); if (hit && b.t >= hr + 55 * 60000) { exit = b.c; st = b.t; break; } }
    }
    if (exit == null) { const last = leg.c.filter(b => b.t < tEnd).pop(); exit = last ? last.c : e; } else stops.push({ call, t: st });
    pnl += e - exit;
  }
  return { pnl, stops, credit: ec + ep };
}
const avg = a => a.reduce((p, c) => p + c, 0) / a.length;
const pct = (a, f) => (a.filter(f).length / a.length * 100);
const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(1);
function table(title, groups, base) {
  console.log('\n' + title); console.log('group'.padEnd(36), 'n'.padStart(4), '| stop %', '| avg P&L % credit', '| avg credit % spot');
  for (const [name, xs] of groups) { if (!xs.length) continue; const r = xs.map(x => base(x)); console.log(name.padEnd(36), String(xs.length).padStart(4), '|', (pct(r, q => q.stops.length > 0).toFixed(0) + '%').padStart(6), '|', fmt(avg(r.map((q, i) => q.pnl / q.credit * 100))).padStart(8) + '%', '|', (avg(xs.map(x => (x.ec + x.ep) / x.n.F0 * 100))).toFixed(2) + '%'); }
}
const base2 = x => run(x, 2, 0);
console.log(`nights simulated: ${nights.length}   (${new Date(Math.min(...nights.map(x => x.n.d))).toISOString().slice(0, 10)} .. ${new Date(Math.max(...nights.map(x => x.n.d))).toISOString().slice(0, 10)})`);
const R2 = nights.map(base2);
console.log(`2x stop, exit 07:30 IST: stopped on ${pct(R2, q => q.stops.length > 0).toFixed(1)}% of nights (call leg ${pct(R2, q => q.stops.some(s => s.call)).toFixed(1)}%, put leg ${pct(R2, q => q.stops.some(s => !s.call)).toFixed(1)}%), avg P&L ${fmt(avg(R2.map(q => q.pnl / q.credit * 100)))}% of credit, avg credit ${avg(nights.map(x => (x.ec + x.ep) / x.n.F0 * 100)).toFixed(2)}% of spot`);

// IV path rows (from the earlier script's definitions)
const ivrow = x => {
  const d = x.n.d, n = IVC[x.k]; const ivAt = (open, arr, K, exp) => { const r = arr.find(y => y[0] === open); const F = spotAt.get(open); return r && F ? straddleIv(r[1], r[2], F, K, (exp - (open + H)) / (365 * D1)) * 100 : null; };
  const a0 = ivAt(d + 1 * H, n.A, n.K1, n.e1), a1 = ivAt(d + 10 * H, n.A, n.K1, n.e1), b0 = ivAt(d + 12 * H, n.B, n.K2, n.e2), b1 = ivAt(d + 15 * H, n.B, n.K2, n.e2), b2 = ivAt(d + 16 * H, n.B, n.K2, n.e2), c1 = ivAt(d + D1 + 1 * H, n.B, n.K2, n.e2);
  if ([a0, a1, b0, b1, b2, c1].some(v => v == null || !isFinite(v))) return null; return { pre: (a1 / a0 - 1) * 100 + (b2 / b0 - 1) * 100, last: (b2 / b1 - 1) * 100, C: (c1 / b2 - 1) * 100, lvl: b2 };
};
for (const x of nights) x.r = ivrow(x); const ok = nights.filter(x => x.r);
table('By weekday (22:30 entry, 2x stop)', [1, 2, 3, 4, 5].map(w => [['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][w], ok.filter(x => x.wd === w)]), base2);
// tradeable IV filters
const mw = {}; for (let w = 1; w <= 5; w++) { const a = ok.filter(x => x.wd === w).map(x => x.r.pre).sort((p, q) => p - q); mw[w] = a[Math.floor(a.length / 2)]; }
const dev = x => x.r.pre - mw[x.wd], sorted = [...ok].sort((p, q) => dev(p) - dev(q)), qn = i => dev(sorted[Math.floor(sorted.length * i)]);
table('TRADEABLE: IV move before 22:30 vs that weekday\'s usual', [['IV fell MOST (bottom 20%)', ok.filter(x => dev(x) <= qn(.2))], ['fell more than usual', ok.filter(x => dev(x) > qn(.2) && dev(x) <= qn(.4))], ['about usual', ok.filter(x => dev(x) > qn(.4) && dev(x) <= qn(.6))], ['fell less', ok.filter(x => dev(x) > qn(.6) && dev(x) <= qn(.8))], ['ROSE most (top 20%)', ok.filter(x => dev(x) > qn(.8))]], base2);
table('TRADEABLE: last hour before entry (21:30 -> 22:30)', [['IV falling > 2%', ok.filter(x => x.r.last < -2)], ['flat', ok.filter(x => x.r.last >= -2 && x.r.last <= 2)], ['IV rising > 2%', ok.filter(x => x.r.last > 2)]], base2);
const lv = [...ok].sort((p, q) => p.r.lvl - q.r.lvl), l1 = lv[Math.floor(lv.length / 3)].r.lvl, l2 = lv[Math.floor(lv.length * 2 / 3)].r.lvl;
table(`TRADEABLE: N2N IV level at 22:30 (terciles ${l1.toFixed(0)} / ${l2.toFixed(0)})`, [['low IV', ok.filter(x => x.r.lvl <= l1)], ['mid IV', ok.filter(x => x.r.lvl > l1 && x.r.lvl <= l2)], ['high IV', ok.filter(x => x.r.lvl > l2)]], base2);
const cr = [...nights].sort((p, q) => (p.ec + p.ep) / p.n.F0 - (q.ec + q.ep) / q.n.F0), c1 = (a => (a.ec + a.ep) / a.n.F0)(cr[Math.floor(cr.length / 3)]), c2 = (a => (a.ec + a.ep) / a.n.F0)(cr[Math.floor(cr.length * 2 / 3)]);
table(`TRADEABLE: credit as % of spot (terciles ${(c1 * 100).toFixed(2)}% / ${(c2 * 100).toFixed(2)}%)`, [['thin credit', nights.filter(x => (x.ec + x.ep) / x.n.F0 <= c1)], ['medium', nights.filter(x => (x.ec + x.ep) / x.n.F0 > c1 && (x.ec + x.ep) / x.n.F0 <= c2)], ['rich credit', nights.filter(x => (x.ec + x.ep) / x.n.F0 > c2)]], base2);
// hindsight: what IV did after entry
table('HINDSIGHT (not tradeable): IV change 22:30 -> 07:30', [['IV fell > 5%', ok.filter(x => x.r.C < -5)], ['fell 0..5%', ok.filter(x => x.r.C >= -5 && x.r.C < 0)], ['rose 0..5%', ok.filter(x => x.r.C >= 0 && x.r.C < 5)], ['rose > 5%', ok.filter(x => x.r.C >= 5)]], base2);

// why stopped: price alone or IV needed?
let pr = 0, ivn = 0, tot = 0, advs = []; for (const x of nights) { const q = run(x, 2, 0); for (const s of q.stops) { const leg = s.call ? x.n.c : x.n.p, e = s.call ? x.ec : x.ep, K = leg.K, hr = Math.floor(s.t / H) * H, F = spotAt.get(hr) || x.n.F0, T = (x.n.e2 - s.t) / (365 * D1), sig0 = legIv(e, x.n.F0, K, (x.n.e2 - (x.n.d + 17 * H)) / (365 * D1), s.call); if (!sig0) continue; const hiPx = s.call ? hiAt.get(hr) : loAt.get(hr); const pred = b76(hiPx || F, K, T, sig0, s.call); tot++; if (pred >= 2 * e) pr++; else ivn++; advs.push(Math.abs((hiPx || F) / x.n.F0 - 1) * 100); } }
advs.sort((p, q) => p - q);
console.log(`\nWHY the legs were stopped (${tot} stopped legs): spot move alone at constant IV reaches 2x in ${(pr / tot * 100).toFixed(0)}%; the rest needed IV to rise too (${(ivn / tot * 100).toFixed(0)}%). Spot move from entry at the stop hour: median ${advs[Math.floor(advs.length / 2)].toFixed(2)}%, 25th ${advs[Math.floor(advs.length / 4)].toFixed(2)}%, 75th ${advs[Math.floor(advs.length * 3 / 4)].toFixed(2)}%`);

// remedies on the same nights
console.log('\nREMEDIES (same nights, same entries)'); console.log('rule'.padEnd(40), 'stop %', '| avg P&L % credit', '| worst night % credit', '| total P&L % credit (sum)');
for (const [nm, f] of [['stop 1.5x', x => run(x, 1.5, 0)], ['stop 2x (current)', x => run(x, 2, 0)], ['stop 2.5x', x => run(x, 2.5, 0)], ['stop 3x', x => run(x, 3, 0)], ['stop 4x', x => run(x, 4, 0)], ['no stop (hold to 07:30)', x => run(x, 0, 0)]]) {
  const r = nights.map(f); console.log(nm.padEnd(40), (pct(r, q => q.stops.length > 0).toFixed(0) + '%').padStart(6), '|', fmt(avg(r.map(q => q.pnl / q.credit * 100))).padStart(8) + '%', '|', fmt(Math.min(...r.map(q => q.pnl / q.credit * 100))).padStart(8) + '%', '|', fmt(r.reduce((p, q) => p + q.pnl / q.credit * 100, 0)).padStart(9));
}
