/**
 * FIVE-YEAR ADX BACKTEST — does low / falling trend-strength (range-bound) protect the strangle?
 * ADX(14) computed on 1h and 4h bars (to find the suitable timeframe). For each weekday night at
 * entry we read ADX level + slope, simulate the overnight 0.15Δ strangle (DVOL IV, BS legs, stop@2×),
 * and bucket the stop rate. Honest caveats: DVOL=30d IV proxy; legs modelled; 1h/4h bars.
 * Run: node scripts/fiveyear_adx.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);

// Wilder ADX(14) over bars [{t,h,l,c}] → Map(t → adx)
function adxSeries(bars,per=14){
  const out=new Map(); if(bars.length<per*2)return out;
  let tr=0,pdm=0,ndm=0; const sm={tr:0,p:0,n:0}; let adx=0,dxCount=0,dxSum=0,prevAdx=null;
  for(let i=1;i<bars.length;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    const trv=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
    const up=h-ph,dn=pl-l; const pdmv=(up>dn&&up>0)?up:0, ndmv=(dn>up&&dn>0)?dn:0;
    if(i<=per){sm.tr+=trv;sm.p+=pdmv;sm.n+=ndmv; if(i===per){/*seed done*/}continue;}
    sm.tr=sm.tr-sm.tr/per+trv; sm.p=sm.p-sm.p/per+pdmv; sm.n=sm.n-sm.n/per+ndmv;
    const pdi=100*sm.p/sm.tr, ndi=100*sm.n/sm.tr; const dx=100*Math.abs(pdi-ndi)/((pdi+ndi)||1);
    dxCount++;
    if(dxCount<per){dxSum+=dx; if(dxCount===per-1){adx=dxSum/per;}}
    else{adx=(adx*(per-1)+dx)/per; out.set(bars[i].t,adx);}
  }
  return out;
}

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8')); // [[t,h,l,c]]
  const b1=prices.map(b=>({t:b[0],h:b[1],l:b[2],c:b[3]}));
  const byT=new Map();for(const b of b1)byT.set(b.t,b);
  // aggregate 4h
  const g4=new Map();
  for(const b of b1){const k=Math.floor(b.t/(4*HOUR))*4*HOUR;const e=g4.get(k)||{t:k,h:-1e9,l:1e9,c:0,last:0};e.h=Math.max(e.h,b.h);e.l=Math.min(e.l,b.l);e.c=b.c;e.last=b.t;g4.set(k,e);}
  const b4=[...g4.values()].sort((a,b)=>a.t-b.t);
  const adx1=adxSeries(b1),adx4=adxSeries(b4);
  const at4=(t)=>{let k=Math.floor(t/(4*HOUR))*4*HOUR;for(let i=0;i<8;i++){if(adx4.has(k))return adx4.get(k);k-=4*HOUR;}return null;};
  const at1=(t)=>{let k=t;for(let i=0;i<8;i++){if(adx1.has(k))return adx1.get(k);k-=HOUR;}return null;};
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;

  const mk=()=>[[0,20,'<20 range'],[20,25,'20–25'],[25,30,'25–30'],[30,40,'30–40'],[40,99,'40+ trend']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  const a1=mk(),a4=mk(); const slope={rise:{n:0,s:0},fall:{n:0,s:0}};
  let total=0;
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry.c>0))continue;
    const x1=at1(E),x4=at4(E);if(x1==null||x4==null)continue;
    const x1prev=at1(E-6*HOUR);
    const S0=entry.c,iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b.h,Kc,T,iv,'c')>=2*c0||bs(b.l,Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;total++;
    const put1=a1.find(x=>x1>=x.lo&&x1<x.hi);if(put1){put1.n++;if(stop)put1.s++;}
    const put4=a4.find(x=>x4>=x.lo&&x4<x.hi);if(put4){put4.n++;if(stop)put4.s++;}
    if(x1prev!=null){const k=x1>=x1prev?'rise':'fall';slope[k].n++;if(stop)slope[k].s++;}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(80));
  console.log(`FIVE-YEAR ADX — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(80));
  console.log('\n1) ADX(14) on 1h at entry:');
  console.log('  bucket        n    stop%');
  for(const x of a1)if(x.n)console.log(`  ${x.lab.padEnd(11)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n2) ADX(14) on 4h at entry:');
  console.log('  bucket        n    stop%');
  for(const x of a4)if(x.n)console.log(`  ${x.lab.padEnd(11)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n3) ADX 1h RISING vs FALLING (last 6h):');
  console.log(`  rising : ${String(slope.rise.n).padStart(4)}  stop ${pct(slope.rise.s,slope.rise.n)}%`);
  console.log(`  falling: ${String(slope.fall.n).padStart(4)}  stop ${pct(slope.fall.s,slope.fall.n)}%`);
  console.log('\n  Reads: lower / falling ADX = range-bound = safer for the strangle? Which timeframe separates best?');
}
main();
