/**
 * FIVE-YEAR ANCHORED-VWAP + VOLUME BACKTEST. VWAP anchored at 00:00 UTC each day; at entry (17:00 UTC)
 * we measure how far price sits from fair value (VWAP) — in % and in volume-weighted σ. Is selling near
 * VWAP (fair value, mean-reverting) safer than selling when price is stretched away from it?
 * Legs BS-modelled (DVOL IV, 0.15Δ, stop@2×). Honest caveats: day-anchored VWAP (one anchor choice);
 * DVOL=30d IV; 1h bars; modelled legs.
 * Run: node scripts/fiveyear_vwap.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);

async function fetchVol(){
  const CACHE=P('./btc-1h-5y-vol.json');
  if(fs.existsSync(CACHE)){const c=JSON.parse(fs.readFileSync(CACHE,'utf8'));if(c.length>40000)return c;}
  const end=Date.now(),start=end-5*365*DAY;const out=[];let t=start;
  while(t<end){const u=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${t}&limit=1000`;const r=await fetch(u);const a=await r.json();if(!Array.isArray(a)||!a.length)break;
    for(const k of a)out.push([k[0],+k[2],+k[3],+k[4],+k[5]]);t=a[a.length-1][0]+HOUR;if(a.length<1000)break;await new Promise(s=>setTimeout(s,120));}
  fs.writeFileSync(CACHE,JSON.stringify(out));console.log(`[fetched vol] ${out.length} bars`);return out;
}

async function main(){
  const prices=await fetchVol();const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;
  const DI=[[0,0.5,'<0.5%'],[0.5,1,'0.5–1%'],[1,2,'1–2%'],[2,4,'2–4%'],[4,99,'4%+']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  const SI=[[0,0.5,'<0.5σ'],[0.5,1,'0.5–1σ'],[1,1.5,'1–1.5σ'],[1.5,2,'1.5–2σ'],[2,99,'2σ+']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  let total=0;const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry[3]>0))continue;
    // day-anchored VWAP from 00:00 UTC → entry (17 bars)
    let tpv=0,vol=0,n=0;const tps=[];
    for(let h=0;h<=17;h++){const b=byT.get(d+h*HOUR);if(!b)continue;const tp=(b[1]+b[2]+b[3])/3,v=b[4];tpv+=tp*v;vol+=v;tps.push([tp,v]);n++;}
    if(n<12||vol<=0)continue;const vwap=tpv/vol;
    let vv=0;for(const[tp,v]of tps)vv+=v*(tp-vwap)**2;const sigma=Math.sqrt(vv/vol);
    const S0=entry[3];const distPct=Math.abs(S0-vwap)/vwap*100;const distSig=sigma>0?Math.abs(S0-vwap)/sigma:0;
    const iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0||bs(b[2],Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;total++;
    const db=DI.find(x=>distPct>=x.lo&&distPct<x.hi);if(db){db.n++;if(stop)db.s++;}
    const sb=SI.find(x=>distSig>=x.lo&&distSig<x.hi);if(sb){sb.n++;if(stop)sb.s++;}
  }
  const pct=(nn,dd)=>(dd?(nn/dd*100).toFixed(1):'—');
  console.log('='.repeat(80));
  console.log(`FIVE-YEAR ANCHORED-VWAP — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(80));
  console.log('\n1) PRICE DISTANCE FROM DAY-VWAP (% ) at entry:');
  console.log('  distance      n    stop%');
  for(const x of DI)if(x.n)console.log(`  ${x.lab.padEnd(9)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n2) DISTANCE IN VOLUME-WEIGHTED σ (value-area stretch):');
  console.log('  distance      n    stop%');
  for(const x of SI)if(x.n)console.log(`  ${x.lab.padEnd(9)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n  Reads: is selling near VWAP (fair value) safer than selling when price is stretched away?');
}
main();
