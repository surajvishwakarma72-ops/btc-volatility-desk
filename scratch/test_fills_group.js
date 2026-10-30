// Test parse and grouping of Delta fills into strangles
function parseSym(s) {
  const m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/i.exec(String(s || ''));
  return m ? { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], rawExp: m[3] + m[4] + m[5] } : null;
}

function groupFillsToTrades(fills) {
  if (!Array.isArray(fills) || !fills.length) return [];

  // Group fills by expiry
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

    const callPnl = +(g.callSv - g.callBv - g.callFee).toFixed(2);
    const putPnl = +(g.putSv - g.putBv - g.putFee).toFixed(2);
    const totalPnl = +(callPnl + putPnl).toFixed(2);
    const totalFee = +(g.callFee + g.putFee).toFixed(2);
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
      lots: maxLots
    });
  }

  trades.sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt));
  return trades;
}

// Test with trade key fills
const tradeFills = [
  {
    "side": "buy",
    "product_symbol": "P-BTC-78500-301026",
    "size": "1",
    "price": "161",
    "commission": "0.001",
    "created_at": "2026-10-28T05:06:49.090342Z"
  },
  {
    "side": "buy",
    "product_symbol": "C-BTC-84000-301026",
    "size": "1",
    "price": "153",
    "commission": "0.001",
    "created_at": "2026-10-28T05:06:47.919022Z"
  },
  {
    "side": "sell",
    "product_symbol": "P-BTC-78500-301026",
    "size": "1",
    "price": "155",
    "commission": "0.001",
    "created_at": "2026-10-28T05:03:38.550927Z"
  },
  {
    "side": "sell",
    "product_symbol": "C-BTC-84000-301026",
    "size": "1",
    "price": "151",
    "commission": "0.001",
    "created_at": "2026-10-28T05:03:37.438310Z"
  }
];

console.log('Trade key grouped trade:');
console.log(groupFillsToTrades(tradeFills));

