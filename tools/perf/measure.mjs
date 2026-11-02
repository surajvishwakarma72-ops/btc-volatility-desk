// Load-meter run in headless Chrome, no backend (API calls 404 the same way for before and after).
// usage: node measure.mjs <page.html> <publicDir> <outJson> [secondsPerPage]
// Injects the perfmeter script from the current frontend if the page has none, turns it on, then visits
// Desk, Paper and P&L for N seconds each and records perfMeter.report() per page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const [, , pageFile, pubDir, outFile, secsArg] = process.argv;
const SECS = Number(secsArg) || 90;
let html = fs.readFileSync(pageFile, 'utf8');
if (!html.includes('data-module="perfmeter"')) {
  const cur = fs.readFileSync(path.join(pubDir, '..', 'index.html'), 'utf8');
  const m = /<script data-module="perfmeter">[\s\S]*?<\/script>/.exec(cur);
  const anchor = '  <script>/* v105.14 · phone scroll guard.';
  if (!html.includes(anchor)) throw new Error('anchor missing');
  html = html.replace(anchor, '  ' + m[0] + '\n' + anchor);
}
const types = { '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.html': 'text/html', '.webmanifest': 'application/json' };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  const f = path.join(pubDir, path.normalize(u).replace(/^([/\\])+/, ''));
  if (f.startsWith(path.resolve(pubDir)) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"success":false,"error":"no backend"}');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'perfprof-'));
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + prof, '--window-size=1440,900', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => { let b = ''; chrome.stderr.on('data', d => { b += d; const m = /ws:\/\/[^\s]+/.exec(b); if (m) res(m[0]); }); setTimeout(() => rej(new Error('chrome did not start')), 20000); });
const browser = new WebSocket(wsUrl);
await new Promise(r => browser.addEventListener('open', r));
let id = 0; const wait = new Map();
const send = (ws, method, params = {}, sessionId) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
browser.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result || m); wait.delete(m.id); } });
const { targetId } = await send(browser, 'Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send(browser, 'Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(browser, m, p, sessionId);
const ev = async expr => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = `http://127.0.0.1:${port}/`;
await S('Page.navigate', { url: base });
await sleep(3000);
await ev(`localStorage.setItem('perf_meter','1'); true`);
await S('Page.navigate', { url: base });
await sleep(15000); // let start-up settle
const out = { file: path.basename(pageFile), secondsPerPage: SECS, pages: [] };
for (const pg of ['pgDesk', 'pgPaper', 'pgPnl']) {
  await ev(`(document.querySelector('#nav button[data-page="${pg}"], #tabbar button[data-page="${pg}"], button[data-page="${pg}"]')||{click(){}}).click(); true`);
  await sleep(3000);
  await ev(`window.perfMeter && perfMeter.reset(); true`);
  await sleep(SECS * 1000);
  out.pages.push(await ev(`window.perfMeter ? perfMeter.report() : null`));
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(out.pages.map(p => p && `${p.page}: busy ${p.busyMsPerMin} ms/min, intervals ${p.intervalMsPerMin} ms/min, live ${p.liveIntervals}`).join('\n'));
chrome.kill(); srv.close(); process.exit(0);
