async function testTradeKeyCandles() {
  const t0 = Math.floor(new Date('2026-10-28T05:00:00Z').getTime() / 1000);
  const t1 = Math.floor(new Date('2026-10-28T05:10:00Z').getTime() / 1000);

  const u = `https://api.india.delta.exchange/v2/history/candles?resolution=1m&symbol=.DEXBTUSD&start=${t0}&end=${t1}`;
  const r = await fetch(u);
  const j = await r.json();
  console.log('1m Candles result count:', j.result?.length);
  if (j.result?.length) {
    console.log(j.result);
  }
}
testTradeKeyCandles().catch(console.error);
