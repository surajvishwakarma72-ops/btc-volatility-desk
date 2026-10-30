const { execSync } = require('child_process');
const keyPath = 'C:\\Users\\suraj\\.ssh\\oracle_key';
try {
  const ps = execSync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@92.4.74.5 "sudo docker compose -f ~/app/docker-compose.prod.yml ps"`).toString();
  console.log('PS:', ps);
  const logs = execSync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@92.4.74.5 "sudo docker compose -f ~/app/docker-compose.prod.yml logs --tail=25 app"`).toString();
  console.log('LOGS:', logs);
} catch (e) {
  console.error(e.message);
}

