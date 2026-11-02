// Task 2 check: the Desk holds only the chart block; every other section lives in the Tools panel.
import { inventoryExpr } from './inventory.mjs';
export default async ({ ev, sleep, click, cdp }) => {
  await click('pgDesk'); await sleep(4000);
  const r = {};
  r.deskKids = await ev(`[...document.querySelectorAll('#pgDesk .desk > *')].map(e => e.id || e.className)`);
  r.toolsKids = await ev(`[...document.querySelectorAll('#dkToolsIn > *')].map(e => e.id || e.className)`);
  r.hasApi = await ev(`!!(window.dkTools && dkTools.open && dkTools.close && dkTools.isOpen)`);
  if (r.hasApi) {
    await ev(`dkTools.open(); true`); await sleep(400);
    r.openShown = await ev(`(() => { const t = document.getElementById('dkTools'), h = id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().height) : 0; }; return !!(t && !t.hidden && t.getClientRects().length && h('side2') > 50 && h('flowRow') > 50); })()`);
    r.sideCollapsed = await ev(`document.body.classList.contains('v23-wide')`);
    r.btnExpanded = await ev(`document.getElementById('dkToolsBtn').getAttribute('aria-expanded')`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(200);
    r.escCloses = await ev(`!dkTools.isOpen()`);
    await ev(`dkTools.open(); true`); await click('pgPaper'); await sleep(400);
    r.closedOnPage = await ev(`!dkTools.isOpen()`);
    await click('pgDesk'); await sleep(600);
    await ev(`dkTools.open(); document.body.classList.add('gfs'); true`); await sleep(400);
    r.closedOnFs = await ev(`!dkTools.isOpen()`);
    await ev(`document.body.classList.remove('gfs'); true`); await sleep(400);
  }
  r.pill = await ev(`(() => { const p = document.getElementById('vUniversalFloatingPnl'); return !!p && p.isConnected && !p.closest('#dkTools'); })()`);
  r.deskAppends = await ev(`new Promise(res => { const d = document.querySelector('#pgDesk .desk'); let n = 0; const mo = new MutationObserver(l => { for (const m of l) n += m.addedNodes.length; }); mo.observe(d, { childList: true }); setTimeout(() => { mo.disconnect(); res(n); }, 15000); })`);
  r.inventory = await ev(inventoryExpr);
  const want = ['v89Rail', 'v104Lead', 'volRow', 'side2', 'flowRow', 'v110PnlHd', 'v18Trade'];
  r.pass = JSON.stringify(r.deskKids) === '["v22Top"]' && r.toolsKids.length > 0 && r.toolsKids.every(k => want.includes(k)) && r.openShown && r.escCloses && r.closedOnPage && r.closedOnFs && r.pill && r.deskAppends === 0;
  return r;
};
