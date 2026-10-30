import fs from 'fs';
import vm from 'vm';

['frontend/index.html', 'Volatility Desk.html'].forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const regex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match, count = 0, errors = 0;
  while ((match = regex.exec(content)) !== null) {
    count++;
    try {
      new vm.Script(match[1]);
    } catch (e) {
      errors++;
      console.error(`Error in ${file} script #${count}:`, e.message);
    }
  }
  console.log(`${file}: Verified ${count} scripts, ${errors} errors.`);
});

