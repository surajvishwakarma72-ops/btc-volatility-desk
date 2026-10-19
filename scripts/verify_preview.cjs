const http = require('http');

http.get('http://localhost:3000/', res => {
  console.log('/ status:', res.statusCode);
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Includes shadowDash:', data.includes('data-a="shadowDash"'));
    console.log('Includes v149ShadowScript:', data.includes('id="v149ShadowScript"'));
    console.log('Includes dataset script:', data.includes('shadow_backtest_dataset.js'));
  });
});
