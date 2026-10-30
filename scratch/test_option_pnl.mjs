async function testBothOptionCandles() {
  const symP = 'P-BTC-78800-011126';
  const symC = 'C-BTC-83600-011126';
  const start = Math.floor(new Date('2026-10-29T17:05:00Z').getTime() / 1000);
  const end = Math.floor(Date.now() / 1000);

  const [resP, resC] = await Promise.all([
    fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${symP}&start=${start}&end=${end}`).then(r => r.json()),
    fetch(`https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${symC}&start=${start}&end=${end}`).then(r => r.json())
  ]);

  console.log('Put candles count:', resP.result ? resP.result.length : 'none');
  console.log('Call candles count:', resC.result ? resC.result.length : 'none');

  if (resP.result && resC.result) {
    const candlesP = resP.result.slice().sort((a, b) => a.time - b.time);
    const candlesC = resC.result.slice().sort((a, b) => a.time - b.time);

    console.log('Put entry price: 143.5, size: -5 (sold)');
    console.log('Call entry price: 70.0, size: -5 (sold)');

    // For every candle, compute REAL PnL!
    // Since short: PnL = (entryPrice - candlePrice) * size * cv
    // For 5 contracts: size = 5, cv = 0.001
    // PnL = (entryPrice - candleClose) * 0.005
    for (let i = 0; i < Math.min(candlesP.length, candlesC.length); i++) {
      const p = candlesP[i];
      const c = candlesC[i];
      const pPnl = (143.5 - p.close) * 5 * 0.001;
      const cPnl = (70.0 - c.close) * 5 * 0.001;
      const totalPnl = pPnl + cPnl;
      console.log(`Time: ${new Date(p.time * 1000).toISOString().slice(11, 16)} | Put close: ${p.close} (pnl: $${pPnl.toFixed(3)}) | Call close: ${c.close} (pnl: $${cPnl.toFixed(3)}) | Net PnL: $${totalPnl.toFixed(3)}`);
    }
  }
}
testBothOptionCandles();

