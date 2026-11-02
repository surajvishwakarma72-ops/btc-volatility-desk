// Task 3 check: saved height shares (window.dkHeights) are applied by v133.fit().
export default async ({ ev, sleep, click }) => {
  await click('pgDesk'); await sleep(3000);
  const r = { hasApi: await ev(`!!(window.dkHeights && dkHeights.get && dkHeights.set && dkHeights.reset && dkHeights.profile)`) };
  // switch on the owner's favourites: ATM IV, Speed vs IV, Short Strangle
  await ev(`(() => { const on = v132ind.state(); on.iv = true; on.spd = true; on.pulse = true; v132ind.save(); v132ind.apply(true); return true; })()`);
  await sleep(8000);   // ATM IV's default grows when its USUAL FALL box mounts; read the defaults once settled
  const H = `(id => { const e = id === 'candles' ? document.querySelector('#paneG>.chart-box') : document.getElementById(id); return e && getComputedStyle(e).display !== 'none' ? Math.round(e.getBoundingClientRect().height) : null; })`;
  const ph = await ev(`document.getElementById('paneG').clientHeight`);
  const fresh = await ev(`({ iv: ${H}('v138Iv'), cv: ${H}('cvLane'), pulse: ${H}('v153Pulse'), candles: ${H}('candles') })`);
  r.fresh = fresh; r.ph = ph;
  if (!r.hasApi) { r.pass = false; return r; }
  const near = (h, want) => h != null && (Math.abs(h - want) <= 2 || Math.abs(h - want - 24) <= 2);   // +24: the lane carrying the time axis
  await ev(`dkHeights.set({ v138Iv: 0.20, cvLane: 0.08 }); true`); await sleep(400);
  const a = await ev(`({ iv: ${H}('v138Iv'), cv: ${H}('cvLane'), candles: ${H}('candles') })`);
  const minC = await ev(`innerWidth <= 760 ? 180 : 240`);
  // exact shares, unless the candle minimum had to squeeze them (phone: Short Strangle's default alone is 268 px)
  r.t1 = (near(a.iv, 0.20 * ph) && near(a.cv, 0.08 * ph)) || (Math.abs(a.candles - minC) <= 3 && a.iv >= 47 && a.cv >= 47); r.t1v = a;
  await ev(`dkHeights.set({ v138Iv: 0.9 }); true`); await sleep(400);
  const b = await ev(`({ iv: ${H}('v138Iv'), cv: ${H}('cvLane'), pulse: ${H}('v153Pulse'), candles: ${H}('candles') })`);
  const phone = await ev(`innerWidth <= 760`);
  // candles never below min(minimum, what the default layout gives them); lanes never below 48 px
  r.t2 = b.candles >= Math.min(phone ? 180 : 240, fresh.candles) - 3 && [b.iv, b.cv, b.pulse].every(h => h == null || h >= 47); r.t2v = b;
  await ev(`dkHeights.set({ v138Iv: 0.30 }); true`); await sleep(400);
  const c0 = await ev(`${H}('candles')`);
  await ev(`(() => { const on = v132ind.state(); on.rv = true; v132ind.save(); v132ind.apply(true); return true; })()`); await sleep(1500);
  const c1 = await ev(`({ candles: ${H}('candles'), rv: ${H}('v138Rv'), iv: ${H}('v138Iv') })`);
  const u3 = await ev(`JSON.stringify(dkHeights.get())`); await ev(`dkHeights.reset(); true`); await sleep(500);
  const cDef = await ev(`${H}('candles')`); await ev(`dkHeights.set(${u3}); true`); await sleep(400);   // the default layout's candles with RV on
  const floor = Math.min(phone ? 180 : 240, cDef) - 3;
  r.t3 = c1.rv != null && c1.rv >= 47 && c1.candles >= floor && (near(c1.iv, 0.30 * ph) || c1.candles <= floor + 6); r.t3v = { c0, cDef, ...c1 };   // spec: the others keep their shares, the new lane starts at its default
  await ev(`(() => { const on = v132ind.state(); on.rv = false; v132ind.save(); v132ind.apply(true); return true; })()`); await sleep(800);
  await ev(`dkHeights.reset(); true`); await sleep(600);
  const d = await ev(`({ iv: ${H}('v138Iv'), cv: ${H}('cvLane'), pulse: ${H}('v153Pulse'), candles: ${H}('candles') })`);
  r.t4 = ['iv', 'cv', 'pulse', 'candles'].every(k => fresh[k] == null || Math.abs(d[k] - fresh[k]) <= 2); r.t4v = d;
  r.t5 = await ev(`(() => { const p0 = dkHeights.profile(); document.body.classList.add('gfs'); const p1 = dkHeights.profile(); document.body.classList.remove('gfs'); return p0.endsWith('|normal') && p1.endsWith('|full') && p0.split('|')[0] === (innerWidth <= 760 ? 'phone' : 'desk'); })()`);
  r.pass = r.t1 && r.t2 && r.t3 && r.t4 && r.t5;
  return r;
};
