/**
 * Holds desk WebSocket connections open against the LOCAL test stack, to show memory problems before a deploy.
 * Modes: `reader` behaves like an open browser; `stalled` stays connected but stops reading, like a phone with its screen off.
 *
 *   node scripts/ws-soak.mjs [readers] [stalled] [minutes]
 *
 * It refuses any address other than this machine, so it cannot be pointed at the live site by accident.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const BASE = process.env.SOAK_URL || 'http://localhost:4100';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error(`Refusing to run against ${BASE}: local only`);

const readers = Number(process.argv[2] ?? 1);
const stalled = Number(process.argv[3] ?? 2);
const minutes = Number(process.argv[4] ?? 30);

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: process.env.DESK_PASSWORD || 'local-test-only' }),
});
const { token } = await login.json();
if (!token) throw new Error(`Login failed: HTTP ${login.status}`);

const stats = { messages: 0, bytes: 0, closed: 0 };

function open(kind) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/desk`, { headers: { Cookie: `desk_token=${token}` } });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', channels: ['positions', 'tickers', 'fills'] }));
    if (kind === 'stalled') setTimeout(() => ws._socket.pause(), 1000);
  });
  ws.on('message', (d) => { stats.messages += 1; stats.bytes += d.length; });
  ws.on('close', (code) => { stats.closed += 1; console.log(`${new Date().toISOString()} ${kind} socket closed (${code})`); });
  ws.on('error', () => {});
}

for (let i = 0; i < readers; i += 1) open('reader');
for (let i = 0; i < stalled; i += 1) open('stalled');
console.log(`${readers} reader(s), ${stalled} stalled, for ${minutes} min`);

const timer = setInterval(() => console.log(`${new Date().toISOString()} messages=${stats.messages} MB=${(stats.bytes / 1e6).toFixed(1)} closed=${stats.closed}`), 60_000);
setTimeout(() => { clearInterval(timer); process.exit(0); }, minutes * 60_000);
