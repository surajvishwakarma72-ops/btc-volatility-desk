// Load a page in headless Chrome (no backend) and run a check script against it.
// usage: node run-page.mjs <page.html> <publicDir> <check.mjs>
// check.mjs default-exports async ({ ev, sleep, click }) => result (printed as JSON).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [, , pageFile, pubDir, checkFile] = process.argv;
const html = fs.readFileSync(pageFile, 'utf8');
const types = { '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  const f = path.join(pubDir, path.normalize(u).replace(/^([/\\])+/, ''));
  if (f.startsWith(path.resolve(pubDir)) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"success":false,"error":"no backend"}');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'runpage-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof, '--window-size=1440,900', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = /ws:\/\/[^\s]+/.exec(b); if (m) res(m[0]); }); setTimeout(() => rej(new Error('chrome did not start')), 20000); });
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const wait = new Map(); const logs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result || m); wait.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
});
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Runtime.enable');
const ev = async expr => { const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description } : r.result?.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = pg => ev(`(document.querySelector('button[data-page="${pg}"]')||{click(){}}).click(); true`);
await S('Page.navigate', { url: `http://127.0.0.1:${srv.address().port}/` });
await sleep(12000);
const check = (await import(pathToFileURL(path.resolve(checkFile)).href)).default;
const result = await check({ ev, sleep, click });
console.log(JSON.stringify({ result, logs: [...new Set(logs)].slice(0, 40) }, null, 2));
chrome.kill(); srv.close(); process.exit(0);
