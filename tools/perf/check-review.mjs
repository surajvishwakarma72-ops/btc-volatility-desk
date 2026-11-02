// Final-review findings, one check each (run on a phone viewport).
const H = `(id => { const e = id === 'candles' ? document.querySelector('#paneG>.chart-box') : document.getElementById(id); return e && getComputedStyle(e).display !== 'none' ? Math.round(e.getBoundingClientRect().height) : null; })`;
const unlock = `(() => { const g = document.getElementById('vTerminalLockGate'); if (g) g.remove(); return true; })()`;
export default async ({ ev, sleep, click, reload }) => {
  const r = {};
  // 1. a browser that already stored v23_side_hidden = '0' (every old visit did) still gets the folded side column
  await ev(`localStorage.setItem('v23_side_hidden', '0'); localStorage.removeItem('v23_side_hidden_v2'); true`);
  await reload(10000); await ev(unlock);
  r.sideFoldedForOldVisit = await ev(`document.body.classList.contains('v23-wide')`);
  // 2. many lanes + saved shares for every lane: candles stay at or above min(180/240, the default layout's candles)
  await ev(`(() => { dkHeights.reset(); const on = v132ind.state(); for (const k of ['iv', 'spd', 'pulse', 'rv', 'vov', 'dv', 'edge', 'rng', 'adx', 'term', 'skew', 'fund']) on[k] = true; v132ind.save(); v132ind.apply(true); return true; })()`);
  await sleep(8000);
  const cDef = await ev(`${H}('candles')`), minC = await ev(`innerWidth <= 760 ? 180 : 240`);
  await ev(`(() => { const F = window.__v133Fit, m = {}; for (const id of F.lanes) { const e = document.getElementById(id); if (e && getComputedStyle(e).display !== 'none') m[id] = Math.max(48, e.offsetHeight) / F.ph; } dkHeights.set(m); return true; })()`);
  await sleep(800);
  const cNow = await ev(`${H}('candles')`);
  r.floor = { cDef, cNow, minC, lanes: await ev(`__v133Fit.lanes.length`) };
  r.floorOk = cNow >= Math.min(minC, cDef) - 3;
  // 3. dividers stay on their lane when #paneG is scrolled
  r.scroll = await ev(`(() => { const g = document.getElementById('paneG'); const can = g.scrollHeight > g.clientHeight + 5; g.scrollTop = 40; return { can, top: g.scrollTop }; })()`);
  await sleep(400);
  r.drift = await ev(`[...document.querySelectorAll('#paneG .dk-split')].map(s => { const l = document.getElementById(s.dataset.below), a = s.getBoundingClientRect(), b = l.getBoundingClientRect(); return Math.round((a.top + a.height / 2) - b.top); })`);
  r.driftOk = r.drift.length > 0 && r.drift.every(d => Math.abs(d) <= 2);
  await ev(`document.getElementById('paneG').scrollTop = 0; true`);
  // 4. after a drag ends, a later pointercancel on that divider must not replay the old drag
  await ev(`(() => { dkHeights.reset(); const on = v132ind.state(); for (const k of Object.keys(on)) on[k] = false; on.iv = true; on.spd = true; on.pulse = true; on.fut = true; v132ind.save(); v132ind.apply(true); return true; })()`);
  await sleep(4000);
  r.replay = await ev(`new Promise(res => {
    const s = [...document.querySelectorAll('#paneG .dk-split')].find(x => x.dataset.below === 'cvLane'); if (!s) return res('no divider');
    const b = s.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, P = (t, yy) => new PointerEvent(t, { bubbles: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: yy, button: 0, buttons: t === 'pointerup' ? 0 : 1 });
    s.dispatchEvent(P('pointerdown', y)); s.dispatchEvent(P('pointermove', y - 40));
    setTimeout(() => { s.dispatchEvent(P('pointerup', y - 40));
      setTimeout(() => { dkHeights.reset(dkHeights.profile());
        setTimeout(() => { s.dispatchEvent(P('pointercancel', y)); setTimeout(() => res(dkHeights.get() === null ? 'kept reset' : 'REPLAYED ' + JSON.stringify(dkHeights.get())), 300); }, 300);
      }, 300);
    }, 100);
  })`);
  r.replayOk = r.replay === 'kept reset';
  r.pass = r.sideFoldedForOldVisit && r.floorOk && r.driftOk && r.replayOk;
  return r;
};
