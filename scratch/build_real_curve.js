async function buildRealPnlCurve() {
  const pSym = 'P-BTC-78800-011126';
  const cSym = 'C-BTC-83600-011126';
  const pEntry = 95.0;
  const cEntry = 70.0;
  const lots = 5;
  const cv = 0.001;

  const start = Math.floor(new Date('2026-10-29T17:05:00Z').getTime() / 1000);
  const end = Math.floor(Date.now() / 1000);

  const uP = 'https://suraj-voldesk.duckdns.org/api/v1/mkt?u=' + encodeURIComponent(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${pSym}&start=${start}&end=${end}`);
  const uC = 'https://suraj-voldesk.duckdns.org/api/v1/mkt?u=' + encodeURIComponent(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${cSym}&start=${start}&end=${end}`);

  const [resP, resC] = await Promise.all([
    fetch(uP).then(r => r.json()),
    fetch(uC).then(r => r.json())
  ]);

  const pCandles = (resP.result || []).slice().sort((a, b) => a.time - b.time);
  const cCandles = (resC.result || []).slice().sort((a, b) => a.time - b.time);

  // Index call candles by time
  const cMap = new Map();
  cCandles.forEach(c => cMap.set(c.time, c.close));

  const curve = [];
  // First point at entry time: PnL = 0
  curve.push({
    t: start * 1000,
    pnl: 0,
    putPx: pEntry,
    callPx: cEntry
  });

  let lastCallClose = cEntry;
  for (const p of pCandles) {
    if (cMap.has(p.time)) {
      lastCallClose = cMap.get(p.time);
    }
    const pPnl = (pEntry - p.close) * lots * cv;
    const cPnl = (cEntry - lastCallClose) * lots * cv;
    const totalPnl = +(pPnl + cPnl).toFixed(4);

    curve.push({
      t: p.time * 1000,
      pnl: totalPnl,
      putPx: p.close,
      callPx: lastCallClose
    });
  }

  console.log(`Generated ${curve.length} REAL candle PnL points:`);
  console.log('Start point:', curve[0]);
  console.log('Mid point:', curve[Math.floor(curve.length / 2)]);
  console.log('End point:', curve[curve.length - 1]);
}
buildRealPnlCurve();

