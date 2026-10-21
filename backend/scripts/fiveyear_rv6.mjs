/**
 * FIVE-YEAR REALISED-VOL (6h) BACKTEST. Two reads the desk uses:
 *   RV6  = annualised realised vol over the last 6h (from 1h returns) at entry.
 *   accel = RV6 / RV24 — "6h RV surging above 24h RV" = kinetic momentum building (danger).
 * Does high 6h RV, or 6h-over-24h acceleration, predict the overnight strangle's stop? Legs BS-modelled
 * (DVOL IV, 0.15Δ, stop@2×). Honest caveats: DVOL=30d IV proxy; RV from 1h bars (6 points = noisy); modelled legs.
 * Run: node scripts/fiveyear_rv6.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
const ANN=Math.sqrt(24*365);

function rvAnn(byT,E,hours){let s=0,n=0;for(let h=hours;h>=1;h--){const a=byT.get(E-h*HOUR),b=byT.get(E-(h-1)*HOUR);if(a&&b&&a[3]>0&&b[3]>0){const r=Math.log(b[3]/a[3]);s+=r*r;n++;}}return n>=Math.ceil(hours*0.7)?Math.sqrt(s/n)*ANN*100:null;}

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;
  const lvl=[[0,30,'<30'],[30,50,'30–50'],[50,70,'50–70'],[70,100,'70–100'],[100,999,'100+']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  const acc=[[0,0.8,'<0.8 decel'],[0.8,1.2,'0.8–1.2 steady'],[1.2,1.6,'1.2–1.6 accel'],[1.6,99,'1.6+ surging']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  let total=0;const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry[3]>0))continue;
    const rv6=rvAnn(byT,E,6),rv24=rvAnn(byT,E,24);if(rv6==null||rv24==null)continue;
    const accel=rv6/rv24;
    const S0=entry[3],iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0||bs(b[2],Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;total++;
    const L=lvl.find(x=>rv6>=x.lo&&rv6<x.hi);if(L){L.n++;if(stop)L.s++;}
    const A=acc.find(x=>accel>=x.lo&&accel<x.hi);if(A){A.n++;if(stop)A.s++;}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(80));
  console.log(`FIVE-YEAR RV(6h) — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(80));
  console.log('\n1) RV6 LEVEL (annualised %) at entry:');
  console.log('  bucket       n    stop%');
  for(const x of lvl)if(x.n)console.log(`  ${x.lab.padEnd(10)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n2) ACCELERATION  RV6 / RV24 (the desk signal):');
  console.log('  bucket           n    stop%');
  for(const x of acc)if(x.n)console.log(`  ${x.lab.padEnd(14)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n  Reads: does hot 6h RV / 6h-over-24h acceleration flag the nights that stop?');
}
main();
