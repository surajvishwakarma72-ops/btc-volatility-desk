/**
 * FIVE-YEAR RANGE-24H BACKTEST — using the desk's own formula.
 *   range24 (ex) = max( ln(hi/S0), ln(S0/lo) ) over trailing 24h  (S0 = close 24h ago)  [frontend range24()]
 *   ratio        = range24% ÷ DVOL implied daily move  (the tile: "24h move ÷ DVOL day move · 1–2× good")
 *   implied daily move = DVOL / sqrt(365).
 * Does a stretched 24h range (ratio > 2 = expansion) flag the overnight strangle's stop? Legs BS-modelled
 * (DVOL IV, 0.15Δ, stop@2×). Honest caveats: DVOL=30d IV proxy; 1h bars; modelled legs.
 * Run: node scripts/fiveyear_range24.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;
  const RT=[[0,1,'<1 quiet'],[1,2,'1–2 good'],[2,3,'2–3 expand'],[3,99,'3+ blown']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  const EX=[[0,2,'<2%'],[2,4,'2–4%'],[4,6,'4–6%'],[6,10,'6–10%'],[10,99,'10%+']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  let total=0;const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry[3]>0))continue;
    const s0bar=byT.get(E-24*HOUR);if(!s0bar||!(s0bar[3]>0))continue;const S0=s0bar[3];
    let hi=-Infinity,lo=Infinity,cov=0;
    for(let h=23;h>=0;h--){const b=byT.get(E-h*HOUR);if(!b)continue;cov++;if(b[1]>hi)hi=b[1];if(b[2]<lo)lo=b[2];}
    if(cov<18||!(hi>0)||!(lo>0))continue;
    const ex=Math.max(Math.log(hi/S0),Math.log(S0/lo))*100;           // desk formula
    const impDaily=ivPct/Math.sqrt(365);                              // DVOL implied daily move %
    const ratio=ex/impDaily;
    const S=entry[3],iv=ivPct/100;const Kc=strikeK(S,T0,iv,0.15,'c'),Kp=strikeK(S,T0,iv,0.15,'p');
    const c0=bs(S,Kc,T0,iv,'c'),p0=bs(S,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0||bs(b[2],Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;total++;
    const rb=RT.find(x=>ratio>=x.lo&&ratio<x.hi);if(rb){rb.n++;if(stop)rb.s++;}
    const eb=EX.find(x=>ex>=x.lo&&ex<x.hi);if(eb){eb.n++;if(stop)eb.s++;}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(80));
  console.log(`FIVE-YEAR RANGE-24H — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(80));
  console.log('\n1) RANGE24 ÷ DVOL daily move (the tile metric, 1–2× "good"):');
  console.log('  ratio bucket    n    stop%');
  for(const x of RT)if(x.n)console.log(`  ${x.lab.padEnd(11)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n2) RAW 24h max excursion % (max(ln hi/S0, ln S0/lo)):');
  console.log('  move bucket    n    stop%');
  for(const x of EX)if(x.n)console.log(`  ${x.lab.padEnd(10)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n  Reads: is a stretched 24h range (ratio >2 = expansion) actually a stop warning?');
}
main();
