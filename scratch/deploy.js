const { execSync } = require('child_process');

console.log('1. Creating git archive dist.tgz...');
execSync('git archive -o dist.tgz HEAD ":!backend/src/backtest/output/*.bin"', { stdio: 'inherit' });

console.log('2. Uploading dist.tgz to Oracle Cloud VM...');
const keyPath = 'C:\\Users\\suraj\\.ssh\\oracle_key';
execSync(`scp -i "${keyPath}" -o StrictHostKeyChecking=no dist.tgz ubuntu@92.4.74.5:~/app/dist.tgz`, { stdio: 'inherit' });

console.log('3. Unpacking and restarting Docker services...');
const remoteCmd = 'cd ~/app && tar -xzf dist.tgz && sudo docker compose -f docker-compose.prod.yml up -d --build';
execSync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@92.4.74.5 "${remoteCmd}"`, { stdio: 'inherit' });

console.log('Deployment complete!');
