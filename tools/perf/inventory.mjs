// Check script for run-page.mjs: every visible control inside the Desk chart panel (#chartp), sorted.
// Used before and after a layout change to prove nothing on the chart was removed.
export const inventoryExpr = `(() => {
  const root = document.getElementById('chartp'); if (!root) return ['no #chartp'];
  const shown = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const out = new Set();
  for (const e of root.querySelectorAll('button, [role=button], [role=tab], select, input, label')) {
    if (!shown(e) || e.closest('#dkTools')) continue;
    const own = e.id ? '#' + e.id : (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '');
    const txt = (e.getAttribute('aria-label') || e.title || e.textContent || e.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    out.add(e.tagName.toLowerCase() + ' ' + own + ' :: ' + txt);
  }
  return [...out].sort();
})()`;
export default async ({ ev, sleep, click }) => { await click('pgDesk'); await sleep(9000); return ev(inventoryExpr); };
