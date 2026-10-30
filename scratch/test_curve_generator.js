async function fetchRealOptionCurve(pLeg, cLeg, t0) {
  const pSym = pLeg.product_symbol;
  const cSym = cLeg.product_symbol;
  const pEntry = +pLeg.entry_price || 0;
  const cEntry = +cLeg.entry_price || 0;
  const pMark = +pLeg.mark_price || 0;
  const cMark = +cLeg.mark_price || 0;
  const lots = Math.max(Math.abs(+pLeg.size || 0), Math.abs(+cLeg.size || 0)) || 5;
  const cv = 0.001;

  const tStartSec = Math.floor(t0 / 1000);
  const tEndSec = Math.floor(Date.now() / 1000);

  const uP = 'https://suraj-voldesk.duckdns.org/api/v1/mkt?u=' + encodeURIComponent(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${pSym}&start=${tStartSec}&end=${tEndSec}`);
  const uC = 'https://suraj-voldesk.duckdns.org/api/v1/mkt?u=' + encodeURIComponent(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${cSym}&start=${tStartSec}&end=${tEndSec}`);

  const [resP, resC] = await Promise.all([
    fetch(uP).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(uC).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);

  const pCandles = (resP && resP.result ? resP.result : []).slice().sort((a, b) => a.time - b.time);
  const cCandles = (resC && resC.result ? resC.result : []).slice().sort((a, b) => a.time - b.time);

  const cMap = new Map();
  cCandles.forEach(c => cMap.set(c.time, c.close));

  const pMap = new Map();
  pCandles.forEach(p => pMap.set(p.time, p.close));

  // Collect all unique timestamps
  const allTimes = Array.from(new Set([...pCandles.map(x => x.time), ...cCandles.map(x => x.time)])).sort((a, b) => a - b);

  const curve = [];
  // Point 0 at entry
  curve.push({
    t: t0,
    pnl: 0,
    pPnl: 0,
    cPnl: 0,
    putPx: pEntry,
    callPx: cEntry
  });

  let lastPClose = pEntry;
  let lastCClose = cEntry;

  for (const timeSec of allTimes) {
    if (pMap.has(timeSec)) lastPClose = pMap.get(timeSec);
    if (cMap.has(timeSec)) lastCClose = cMap.get(timeSec);

    const pPnl = (pEntry - lastPClose) * lots * cv;
    const cPnl = (cEntry - lastCClose) * lots * cv;
    const netPnl = +(pPnl + cPnl).toFixed(4);

    curve.push({
      t: timeSec * 1000,
      pnl: netPnl,
      pPnl: +pPnl.toFixed(4),
      cPnl: +cPnl.toFixed(4),
      putPx: lastPClose,
      callPx: lastCClose
    });
  }

  // Final point: Live tick right now!
  const livePPnl = (pEntry - pMark) * lots * cv;
  const liveCPnl = (cEntry - cMark) * lots * cv;
  const liveNet = +(livePPnl + liveCPnl).toFixed(4);

  curve.push({
    t: Date.now(),
    pnl: liveNet,
    pPnl: +livePPnl.toFixed(4),
    cPnl: +liveCPnl.toFixed(4),
    putPx: pMark,
    callPx: cMark,
    isLive: true
  });

  return curve;
}

async function test() {
  const pLeg = { product_symbol: 'P-BTC-78800-011126', entry_price: 95, mark_price: 137.57, size: -5 };
  const cLeg = { product_symbol: 'C-BTC-83600-011126', entry_price: 70, mark_price: 45.03, size: -5 };
  const t0 = new Date('2026-10-29T17:05:14Z').getTime();

  const curve = await fetchRealOptionCurve(pLeg, cLeg, t0);
  console.log(`Generated curve with ${curve.length} points.`);
  console.log('Start:', curve[0]);
  console.log('Latest live tick:', curve[curve.length - 1]);
}
test();

