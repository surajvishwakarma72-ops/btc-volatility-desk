import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';
import { signDelta } from './dist/routes/delta.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parseSym(s) {
  const str = String(s || '').trim();
  const m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/i.exec(str);
  if (m) {
    return { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], rawExp: m[3] + m[4] + m[5] };
  }
  const m2 = /^(?:([CP])-)?BTC-(?:(\d{2}[A-Za-z]{3}\d{2})-)?(\d+)(?:-([CP]))?$/i.exec(str);
  if (m2) {
    return { type: (m2[1] || m2[4] || '').toUpperCase(), K: +m2[3], exp: m2[2] || 'unknown', rawExp: m2[2] || 'unknown' };
  }
  return null;
}

function groupFillsToTrades(fills) {
  if (!Array.isArray(fills) || !fills.length) return [];
  const byExp = new Map();
  for (const f of fills) {
    const sym = f.product_symbol || (f.product && f.product.symbol);
    const p = parseSym(sym);
    if (!p) continue;

    let group = byExp.get(p.exp);
    if (!group) {
      group = {
        exp: p.exp,
        rawExp: p.rawExp,
        first: Infinity,
        last: 0,
        callBuy: 0, callSell: 0, callBv: 0, callSv: 0, callFee: 0,
        putBuy: 0, putSell: 0, putBv: 0, putSv: 0, putFee: 0,
        Kc: null, Kp: null,
        cv: +(f.product && f.product.contract_value) || +(f.meta_data && f.meta_data.contract_value) || 0.001
      };
      byExp.set(p.exp, group);
    }

    const t = new Date(f.created_at).getTime();
    if (t < group.first) group.first = t;
    if (t > group.last) group.last = t;

    const size = Math.abs(+f.size || 0);
    const px = +f.price || 0;
    const fee = Math.abs(+f.commission || 0);
    const side = String(f.side).toLowerCase();

    if (p.type === 'C') {
      group.Kc = p.K;
      group.callFee += fee;
      if (side === 'buy') { group.callBuy += size; group.callBv += size * px * group.cv; }
      else { group.callSell += size; group.callSv += size * px * group.cv; }
    } else {
      group.Kp = p.K;
      group.putFee += fee;
      if (side === 'buy') { group.putBuy += size; group.putBv += size * px * group.cv; }
      else { group.putSell += size; group.putSv += size * px * group.cv; }
    }
  }

  const trades = [];
  for (const [exp, g] of byExp.entries()) {
    const callNetLots = g.callSell - g.callBuy;
    const putNetLots = g.putSell - g.putBuy;
    const isOpen = callNetLots !== 0 || putNetLots !== 0;

    const callPnl = +(g.callSv - g.callBv - g.callFee).toFixed(4);
    const putPnl = +(g.putSv - g.putBv - g.putFee).toFixed(4);
    const totalPnl = +(callPnl + putPnl).toFixed(4);
    const totalFee = +(g.callFee + g.putFee).toFixed(4);
    const maxLots = Math.max(g.callSell, g.putSell, g.callBuy, g.putBuy);

    trades.push({
      id: 'dex-' + exp,
      exp: exp,
      rawExp: g.rawExp,
      openedAt: g.first,
      closedAt: isOpen ? null : g.last,
      open: isOpen,
      pnl: totalPnl,
      callPnl: callPnl,
      putPnl: putPnl,
      fee: totalFee,
      Kc: g.Kc,
      Kp: g.Kp,
      lots: maxLots,
      callNetLots,
      putNetLots
    });
  }

  trades.sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt));
  return trades;
}

async function sim() {
  const u = (await pool.query("SELECT * FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];

  // Fetch read positions & fills
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id])).rows[0];
  let roPos = [], roFills = [];
  if (rRead) {
    const k = open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag });
    const s = open({ data: rRead.secret_enc, salt: rRead.secret_salt, iv: rRead.secret_iv, tag: rRead.secret_tag });
    const ts = String(Math.floor(Date.now() / 1000));
    const pathP = '/v2/positions/margined';
    const sigP = signDelta(s, 'GET', ts, pathP, '?contract_types=call_options,put_options');
    const rP = await fetch('https://api.india.delta.exchange' + pathP + '?contract_types=call_options,put_options', {
      headers: { 'api-key': k, timestamp: ts, signature: sigP, Accept: 'application/json' }
    });
    const dP = await rP.json();
    roPos = dP.result || [];

    const pathF = '/v2/fills';
    const sigF = signDelta(s, 'GET', ts, pathF, '?contract_types=call_options,put_options&page_size=100');
    const rF = await fetch('https://api.india.delta.exchange' + pathF + '?contract_types=call_options,put_options&page_size=100', {
      headers: { 'api-key': k, timestamp: ts, signature: sigF, Accept: 'application/json' }
    });
    const dF = await rF.json();
    roFills = dF.result || [];
  }

  // Fetch trade positions & fills
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id])).rows[0];
  let rtPos = [], rtFills = [];
  if (rTrade) {
    const k = open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag });
    const s = open({ data: rTrade.secret_enc, salt: rTrade.secret_salt, iv: rTrade.secret_iv, tag: rTrade.secret_tag });
    const ts = String(Math.floor(Date.now() / 1000));
    const pathP = '/v2/positions/margined';
    const sigP = signDelta(s, 'GET', ts, pathP, '?contract_types=call_options,put_options');
    const rP = await fetch('https://api.india.delta.exchange' + pathP + '?contract_types=call_options,put_options', {
      headers: { 'api-key': k, timestamp: ts, signature: sigP, Accept: 'application/json' }
    });
    const dP = await rP.json();
    rtPos = dP.result || [];

    const pathF = '/v2/fills';
    const sigF = signDelta(s, 'GET', ts, pathF, '?contract_types=call_options,put_options&page_size=100');
    const rF = await fetch('https://api.india.delta.exchange' + pathF + '?contract_types=call_options,put_options&page_size=100', {
      headers: { 'api-key': k, timestamp: ts, signature: sigF, Accept: 'application/json' }
    });
    const dF = await rF.json();
    rtFills = dF.result || [];
  }

  console.log('=== MODE: READ-ONLY ===');
  console.log('Open positions count:', roPos.length);
  const roTrades = groupFillsToTrades(roFills);
  console.log('Grouped trades count:', roTrades.length);
  if (roTrades.length > 0) {
    console.log('Last trade:', roTrades[0]);
  } else {
    console.log('Fallback trade: Oct 23 Strangle (-$9.16)');
  }

  console.log('\n=== MODE: READ+TRADE ===');
  console.log('Open positions count:', rtPos.length);
  if (rtPos.length > 0) {
    console.log('Active Open Position:');
    rtPos.forEach(p => console.log('  ' + p.product_symbol + ' size=' + p.size + ' uPnL=' + p.unrealized_pnl));
  }
  const rtTrades = groupFillsToTrades(rtFills);
  console.log('Grouped trades count:', rtTrades.length);
  const closedRt = rtTrades.filter(t => !t.open);
  console.log('Last closed trade:', closedRt[0]);

  await pool.end();
}
sim();

