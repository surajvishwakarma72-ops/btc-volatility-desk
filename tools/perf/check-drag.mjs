// Task 4 check: CoinGlass-style dividers. Mouse drag on desktop, touch drag on a phone, double-click reset,
// "Reset heights" in the ƒx menu, persistence across a reload, and the old full-screen-only handles gone.
const H = `(id => { const e = id === 'candles' ? document.querySelector('#paneG>.chart-box') : document.getElementById(id); return e && getComputedStyle(e).display !== 'none' ? Math.round(e.getBoundingClientRect().height) : null; })`;
const favs = `(() => { const on = v132ind.state(); on.iv = true; on.spd = true; on.pulse = true; v132ind.save(); v132ind.apply(true); return true; })()`;
// centre of the divider that sits right above lane `id`
const handle = id => `(() => { const s = [...document.querySelectorAll('#paneG .dk-split')].find(x => x.dataset.below === '${id}'); if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`;
export default async ({ ev, sleep, click, cdp, reload }) => {
  // test browser only: no login here, so the terminal's lock screen covers the page and would catch every real input
  const unlock = `(() => { const g = document.getElementById('vTerminalLockGate'); if (g) g.remove(); return true; })()`;
  await click('pgDesk'); await sleep(2000);
  await ev(unlock);
  await ev(`dkHeights && dkHeights.reset(); true`);
  await ev(favs); await sleep(8000);
  const phone = await ev(`innerWidth <= 760`);
  const r = { phone, splits: await ev(`[...document.querySelectorAll('#paneG .dk-split')].map(s => s.dataset.below)`), oldGone: await ev(`!document.querySelector('.gfs-split')`) };
  const mouse = async (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra });
  const touch = async (type, pts) => cdp('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const drag = async (p, dy) => {
    if (phone) { await touch('touchStart', [{ x: p.x, y: p.y }]); for (let i = 1; i <= 8; i++) { await touch('touchMove', [{ x: p.x, y: p.y + dy * i / 8 }]); await sleep(16); } await touch('touchEnd', []); }
    else { await mouse('mouseMoved', p.x, p.y, { buttons: 0 }); await mouse('mousePressed', p.x, p.y); for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', p.x, p.y + dy * i / 8); await sleep(16); } await mouse('mouseReleased', p.x, p.y + dy); }
    await sleep(500);
  };
  const target = phone ? 'v138Iv' : 'cvLane';   // phone: the divider between the candles and the first lane
  const before = await ev(`({ t: ${H}('${target}'), c: ${H}('candles'), g: document.getElementById('paneG').clientHeight, sy: scrollY })`);
  const p = await ev(handle(target)); r.handle = p;
  if (!p) { r.pass = false; return r; }
  const dy = phone ? 40 : -50;   // phone: the candles start under their minimum, so the drag gives them room   // desktop: Speed vs IV grows 50 px, ATM IV above it gives them up
  await drag(p, dy);
  const after = await ev(`({ t: ${H}('${target}'), c: ${H}('candles'), g: document.getElementById('paneG').clientHeight, sy: scrollY })`);
  r.drag = { before, after };
  // the lane moved by the drag (fit's own one-off window correction can add a few px), and the page did not scroll
  r.dragOk = Math.abs((before.t - after.t) - dy) <= 6 && after.sy === before.sy;
  // a vertical swipe in the middle of the candles must not move any divider
  if (phone) {
    const c = await ev(`(() => { const b = document.querySelector('#paneG>.chart-box').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    const h0 = await ev(`${H}('${target}')`);
    await touch('touchStart', [c]); for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: c.x, y: c.y + 10 * i }]); await sleep(16); } await touch('touchEnd', []); await sleep(400);
    r.swipeOk = (await ev(`${H}('${target}')`)) === h0;
  } else r.swipeOk = true;
  const dragged = after.t;
  await reload(10000); await ev(unlock); await ev(favs); await sleep(6000);
  // saved as a share of the panel height, so compare shares (the panel height can differ by a few px after a reload)
  const g2 = await ev(`document.getElementById('paneG').clientHeight`);
  r.persist = { want: +(dragged / after.g).toFixed(4), got: +((await ev(`${H}('${target}')`)) / g2).toFixed(4) };
  r.persistOk = Math.abs(r.persist.got - r.persist.want) <= 0.01;
  // double-click (double-tap) the divider: that pair goes back to its defaults
  const q = await ev(handle(target));
  if (phone) { for (let i = 0; i < 2; i++) { await touch('touchStart', [q]); await touch('touchEnd', []); await sleep(120); } }
  else { await mouse('mousePressed', q.x, q.y); await mouse('mouseReleased', q.x, q.y); await sleep(120); await mouse('mousePressed', q.x, q.y, { clickCount: 2 }); await mouse('mouseReleased', q.x, q.y, { clickCount: 2 }); }
  await sleep(600);
  r.dbl = { before: before.t, got: await ev(`${H}('${target}')`) };
  const cNow = await ev(`${H}('candles')`), minC = phone ? 180 : 240;
  r.dblOk = Math.abs(r.dbl.got - before.t) <= 8 || (Math.abs(cNow - minC) <= 3 && r.dbl.got < before.t);   // or squeezed because the candles sit at their minimum
  // Reset heights in the ƒx menu
  await drag(await ev(handle(target)), dy);
  await ev(`v132ind.open(); true`); await sleep(500);
  r.resetBtn = await ev(`(() => { const b = document.getElementById('dkResetH'); if (!b) return false; b.click(); return true; })()`);
  await sleep(600);
  r.resetOk = r.resetBtn && Math.abs((await ev(`${H}('${target}')`)) - before.t) <= 3 && (await ev(`dkHeights.get() === null`));
  await ev(`(() => { const m = document.getElementById('v132Ind'); if (m) m.hidden = true; return true; })()`);
  r.pass = r.oldGone && r.dragOk && r.swipeOk && r.persistOk && r.dblOk && r.resetOk;
  return r;
};
