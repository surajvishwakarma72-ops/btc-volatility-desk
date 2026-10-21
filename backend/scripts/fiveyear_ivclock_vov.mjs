/**
 * FIVE-YEAR: (A) IV vs CLOCK and (B) VoV.
 *  A) IV vs clock: the desk's "IV below its 17:30 IST level" check. 17:30 IST = 12:00 UTC (daily roll
 *     anchor); entry 22:30 IST = 17:00 UTC. ivVsClock = DVOL(entry) − DVOL(12:00 UTC). Below = crush
 *     underway (good?); above = IV rising since the clock (bad?). Needs HOURLY DVOL.
 *  B) VoV (vol-of-vol): annualised realised vol of DVOL over trailing 14 days — is the vol regime stable
 *     or whipping around? High VoV = unstable = danger?
 * Legs BS-modelled (DVOL IV, 0.15Δ, stop@2×). Honest caveats: DVOL=30d IV; 1h bars; modelled legs.
 * Run: node scripts/fiveyear_ivclock_vov.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
const hkey=(ts)=>Math.floor(ts/HOUR)*HOUR;

async function fetchDvolHourly(){
  const CACHE=P('./btc-dvol-5y-1h.json');
  if(fs.existsSync(CACHE)){const c=JSON.parse(fs.readFileSync(CACHE,'utf8'));if(c.length>20000)return c;}
  const end=Date.now();let t=1609459200000;const out=[];
  while(t<end){const to=Math.min(t+60*DAY,end);const u=`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${t}&end_timestamp=${to}&resolution=3600`;
    const r=await fetch(u);const j=await r.json();const d=j.result&&j.result.data||[];for(const row of d)out.push([row[0],row[4]]);
    if(!d.length){t=to+HOUR;continue;}t=d[d.length-1][0]+HOUR;await new Promise(s=>setTimeout(s,100));}
  fs.writeFileSync(CACHE,JSON.stringify(out));console.log(`[dvol 1h] ${out.length} pts`);return out;
}

async function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dDay=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8')).sort((a,b)=>a[0]-b[0]);
  const dByDay=new Map();for(const[ts,v]of dDay)dByDay.set(dkey(ts),v);
  const days=dDay.map(x=>({d:dkey(x[0]),v:x[1]}));const idxByDay=new Map();days.forEach((x,i)=>idxByDay.set(x.d,i));
  const dH=await fetchDvolHourly();const dvH=new Map();for(const[ts,v]of dH)dvH.set(hkey(ts),v);
  const T0=3/365;

  const CK=[[-99,-2,'≪ clock <−2'],[-2,-0.5,'below −2..−0.5'],[-0.5,0.5,'at clock ±0.5'],[0.5,2,'above +0.5..2'],[2,99,'rising ≫ +2']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  const VV=[[0,40,'low <40'],[40,70,'mid 40–70'],[70,110,'high 70–110'],[110,999,'wild 110+']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0}));
  let totCk=0,totVv=0;const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dByDay.get(dkey(E));const i=idxByDay.get(dkey(E));
    if(!entry||ivPct==null||i==null||i<14||!(entry[3]>0))continue;
    const S0=entry[3],iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0||bs(b[2],Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;
    // A) IV vs clock (hourly DVOL at 17:00 UTC vs 12:00 UTC)
    const dvEntry=dvH.get(hkey(d+17*HOUR)),dvClock=dvH.get(hkey(d+12*HOUR));
    if(dvEntry!=null&&dvClock!=null){const diff=dvEntry-dvClock;const cb=CK.find(x=>diff>=x.lo&&diff<x.hi);if(cb){cb.n++;if(stop)cb.s++;totCk++;}}
    // B) VoV: annualised stdev of last 14 daily DVOL log-changes
    const rs=[];for(let k=i-13;k<=i;k++){if(days[k-1]&&days[k].v>0&&days[k-1].v>0)rs.push(Math.log(days[k].v/days[k-1].v));}
    if(rs.length>=10){const m=rs.reduce((x,y)=>x+y,0)/rs.length;const sd=Math.sqrt(rs.reduce((s,x)=>s+(x-m)**2,0)/(rs.length-1));const vov=sd*Math.sqrt(365)*100;
      const vb=VV.find(x=>vov>=x.lo&&vov<x.hi);if(vb){vb.n++;if(stop)vb.s++;totVv++;}}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(80));
  console.log(`FIVE-YEAR IV-vs-CLOCK & VoV — stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(80));
  console.log(`\nA) IV vs 17:30 CLOCK — DVOL(entry) − DVOL(12:00 UTC)  [${totCk} nights]:`);
  console.log('  bucket               n    stop%');
  for(const x of CK)if(x.n)console.log(`  ${x.lab.padEnd(18)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log(`\nB) VoV — annualised vol of DVOL, trailing 14d  [${totVv} nights]:`);
  console.log('  bucket               n    stop%');
  for(const x of VV)if(x.n)console.log(`  ${x.lab.padEnd(18)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n  Reads: (A) is IV below its 17:30 clock = crush underway = safer?  (B) does an unstable vol regime (high VoV) stop more?');
}
main();
