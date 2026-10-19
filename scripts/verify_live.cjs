const https = require('https');

https.get('https://truthful-courtesy-production-241d.up.railway.app/', res => {
  console.log('Live HTTP status:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Live has v148ToolbarEcoBtn:', data.includes('v148ToolbarEcoBtn'));
    console.log('Live has shadowDash:', data.includes('data-a="shadowDash"'));
    console.log('Live has dataset script:', data.includes('shadow_backtest_dataset.js'));
    console.log('Live has NO black strip:', !data.includes('mountTicker()'));
  });
}).on('error', err => {
  console.error('Error fetching live URL:', err.message);
});
