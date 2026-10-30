const fs = require('fs');

let content = fs.readFileSync('Volatility Desk.html', 'utf8');
const target = '#pgPnl.v158-deep > :not(#v158Deep)';
console.log('Count of target in Volatility Desk.html:', content.split(target).length - 1);
if (content.includes(target)) {
  content = content.split(target).join('#pgPnl.v158-deep > :not(#v158Deep):not(#vLivePnlTick)');
  fs.writeFileSync('Volatility Desk.html', content, 'utf8');
  console.log('Replaced in Volatility Desk.html');
} else {
  // Let's see what v158 css is in Volatility Desk.html
  const idx = content.indexOf('v158-deep');
  console.log('v158-deep in Volatility Desk.html:', idx);
  if (idx > -1) {
    console.log(content.slice(idx - 100, idx + 200));
  }
}

