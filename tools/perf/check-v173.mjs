// v173 check: USUAL FALL strip gone (chart moves up), Top / Telegram chips hidden, strike picker icon right after ƒx and it opens.
export default async ({ ev, sleep, click }) => {
  await click('pgDesk'); await sleep(9000);
  await ev(`(() => { const g = document.getElementById('vTerminalLockGate'); if (g) g.remove(); return true; })()`);
  const r = await ev(`(() => {
    const vis = id => { const e = document.getElementById(id); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; };
    const sp = document.getElementById('v165Chip'), ind = document.getElementById('v132IndBtn');
    const hdrB = document.querySelector('header.top.hdr').getBoundingClientRect().bottom, cTop = document.getElementById('chartp').getBoundingClientRect().top;
    return { usualFall: vis('v164Lvl'), top: vis('v168ChipTop'), tg: vis('v168ChipTg'), spInToolbar: !!sp && sp.parentNode === ind.parentNode && ind.nextSibling === sp,
      spVisible: vis('v165Chip'), spTitle: sp && sp.title, gapHeaderToChart: Math.round(cTop - hdrB), chartH: Math.round(document.getElementById('chartp').getBoundingClientRect().height) };
  })()`);
  await ev(`document.getElementById('v165Chip').click(); true`); await sleep(800);
  r.sheetOpens = await ev(`[...document.querySelectorAll('[data-v165x]')].some(b => b.getClientRects().length > 0)`);
  r.pass = !r.usualFall && !r.top && !r.tg && r.spInToolbar && r.spVisible && r.sheetOpens && r.gapHeaderToChart < 20;
  return r;
};
