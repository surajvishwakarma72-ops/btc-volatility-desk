// Task 5 check: full screen fills the screen with its own saved heights; lane heights stay put for 60 s without input.
const H = `(id => { const e = id === 'candles' ? document.querySelector('#paneG>.chart-box') : document.getElementById(id); return e && getComputedStyle(e).display !== 'none' ? Math.round(e.getBoundingClientRect().height) : null; })`;
export default async ({ ev, sleep, click }) => {
  await click('pgDesk'); await sleep(2000);
  await ev(`(() => { const g = document.getElementById('vTerminalLockGate'); if (g) g.remove(); dkHeights.reset(); const on = v132ind.state(); on.iv = true; on.spd = true; on.pulse = true; v132ind.save(); v132ind.apply(true); return true; })()`);
  await sleep(8000);
  const r = {};
  // normal view: a saved share; full screen must not carry it over (separate profile)
  await ev(`dkHeights.set({ v138Iv: 0.12 }); true`); await sleep(600);
  const normIv = await ev(`${H}('v138Iv')`);
  await ev(`(() => { const b = document.getElementById('fsBtn'); if (b) b.click(); else { document.body.classList.add('gfs'); v133.fit(); } return true; })()`);
  await sleep(1500);
  r.fsOn = await ev(`document.body.classList.contains('gfs')`);
  r.profile = await ev(`dkHeights.profile()`);
  r.full = await ev(`(() => { const c = document.getElementById('chartp').getBoundingClientRect(); return { bottom: Math.round(c.bottom), vh: innerHeight }; })()`);
  r.fullFills = Math.abs(r.full.bottom - r.full.vh) <= 4;
  const fsIv = await ev(`${H}('v138Iv')`), fsPh = await ev(`document.getElementById('paneG').clientHeight`);
  r.separate = { normIv, fsIv, fsPh, fsSaved: await ev(`JSON.stringify(dkHeights.get())`) };
  r.separateOk = r.profile.endsWith('|full') && r.separate.fsSaved === 'null';
  await ev(`dkHeights.set({ v138Iv: 0.30 }); true`); await sleep(600);
  r.fsShare = { iv: await ev(`${H}('v138Iv')`), want: Math.round(0.30 * fsPh), candles: await ev(`${H}('candles')`) };
  const minC = await ev(`innerWidth <= 760 ? 180 : 240`);
  // the exact share, unless the candle minimum trimmed it
  r.fsShareOk = Math.abs(r.fsShare.iv - r.fsShare.want) <= 3 || Math.abs(r.fsShare.iv - r.fsShare.want - 24) <= 3 || (r.fsShare.candles <= minC + 3 && r.fsShare.iv > 122);   // trimmed by the candle floor (min of the minimum and the default)
  await ev(`(() => { const b = document.getElementById('fsBtn'); if (b && document.body.classList.contains('gfs')) b.click(); else document.body.classList.remove('gfs'); return true; })()`);
  await sleep(1500);
  r.backNormal = { iv: await ev(`${H}('v138Iv')`), was: normIv };
  r.backNormalOk = Math.abs(r.backNormal.iv - normIv) <= 3;
  // steadiness: no height / max-height / min-height change on #paneG or any lane for 60 s
  r.changes = await ev(`new Promise(res => {
    const els = [document.getElementById('paneG'), document.querySelector('#paneG>.chart-box'), ...(window.__v133Fit ? __v133Fit.lanes.map(id => document.getElementById(id)) : [])].filter(Boolean);
    const snap = e => ['height', 'max-height', 'min-height'].map(p => e.style.getPropertyValue(p)).join('|');
    const was = new Map(els.map(e => [e, snap(e)])); const seen = [];
    const mo = new MutationObserver(l => { for (const m of l) { const e = m.target, s = snap(e); if (was.get(e) !== s) { seen.push((e.id || e.className.split(' ')[0]) + ' ' + was.get(e) + ' -> ' + s); was.set(e, s); } } });
    els.forEach(e => mo.observe(e, { attributes: true, attributeFilter: ['style'] }));
    setTimeout(() => { mo.disconnect(); res(seen.slice(0, 10)); }, 60000);
  })`);
  r.steady = r.changes.length === 0;
  r.pass = r.fsOn && r.fullFills && r.separateOk && r.fsShareOk && r.backNormalOk && r.steady;
  return r;
};
