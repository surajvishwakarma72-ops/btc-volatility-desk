const { execSync } = require('child_process');
const keyPath = 'C:\\Users\\suraj\\.ssh\\oracle_key';

console.log('Uploading remote_script.js...');
execSync(`scp -i "${keyPath}" -o StrictHostKeyChecking=no scratch/remote_script.js ubuntu@92.4.74.5:~/app/remote_script.js`, { stdio: 'inherit' });

console.log('Executing inside app container...');
const res = execSync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@92.4.74.5 "sudo docker cp ~/app/remote_script.js app-app-1:/app/backend/remote_script.js && sudo docker exec app-app-1 node /app/backend/remote_script.js"`).toString();
console.log('RESULT:\n', res);

