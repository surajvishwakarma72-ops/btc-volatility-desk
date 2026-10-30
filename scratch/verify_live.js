async function verify() {
  console.log('Testing https://suraj-voldesk.duckdns.org ...');
  const res = await fetch('https://suraj-voldesk.duckdns.org');
  console.log('HTTP Status:', res.status);
  const html = await res.text();
  console.log('HTML length:', html.length);
  console.log('Contains vLivePnlTickCss:', html.includes('vLivePnlTickCss'));
  console.log('Contains vUniversalFloatingPnl:', html.includes('vUniversalFloatingPnl'));
  console.log('Contains makeDraggable:', html.includes('makeDraggable'));
  console.log('Contains fetchRealTradeCurve:', html.includes('fetchRealTradeCurve'));
  console.log('Contains v-light styles:', html.includes('#pgPnl.v-light'));

  const pSym = 'P-BTC-78800-011126';
  const u = 'https://suraj-voldesk.duckdns.org/api/v1/mkt?u=' + encodeURIComponent('https://api.india.delta.exchange/v2/history/candles?resolution=5m&symbol=' + pSym);
  const candleRes = await fetch(u);
  console.log('Candle Proxy HTTP Status:', candleRes.status);
  const candleJson = await candleRes.json();
  console.log('Candle result count for ' + pSym + ':', candleJson && candleJson.result ? candleJson.result.length : 'none');
}

verify().catch(console.error);

