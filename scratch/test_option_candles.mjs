async function testOptionCandles() {
  const sym = 'P-BTC-78800-011126';
  const start = Math.floor(new Date('2026-10-29T17:00:00Z').getTime() / 1000);
  const end = Math.floor(Date.now() / 1000);
  const url = `https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=${sym}&start=${start}&end=${end}`;

  console.log('Fetching:', url);
  const res = await fetch(url);
  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Result length:', data.result ? data.result.length : data);
  if (data.result && data.result.length > 0) {
    console.log('First candle:', data.result[0]);
    console.log('Last candle:', data.result[data.result.length - 1]);
  }
}
testOptionCandles();

