// Inspect Delta ticker data for Greeks and current position state
async function inspect() {
  const BASE = 'https://suraj-voldesk.duckdns.org';

  // 1. Get option tickers (public - includes greeks + mark_iv)
  const r1 = await fetch(BASE + '/api/v1/mkt?u=' + encodeURIComponent('https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options'));
  const d1 = await r1.json();
  const tickers = (d1 && d1.result) ? d1.result : [];
  const relevant = tickers.filter(t => 
    ['P-BTC-78800-011126', 'C-BTC-83600-011126'].includes(t.symbol)
  );
  console.log('\n=== TICKER DATA (Greeks + IV) ===');
  relevant.forEach(t => {
    console.log('\nSymbol:', t.symbol);
    console.log('Mark Price:', t.mark_price);
    console.log('Mark IV:', t.mark_iv);
    console.log('Greeks:', JSON.stringify(t.greeks, null, 2));
    console.log('Spot:', t.spot_price);
    console.log('OI:', t.open_interest);
  });

  // 2. Check app theme toggle state
  const appHtml = await fetch(BASE).then(r => r.text());
  const hasThemeAttr = appHtml.includes('data-theme="light"');
  const hasThemeDark = appHtml.includes('data-theme="dark"');
  console.log('\n=== DEFAULT THEME IN HTML ===');
  console.log('data-theme="light":', hasThemeAttr);
  console.log('data-theme="dark":', hasThemeDark);
  console.log('No data-theme attr:', !hasThemeAttr && !hasThemeDark);
}

inspect().catch(console.error);

