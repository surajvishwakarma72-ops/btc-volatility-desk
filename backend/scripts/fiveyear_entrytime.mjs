/**
 * FIVE-YEAR ENTRY-TIME × WEEKDAY sweep — the best entry hour for EACH weekday (not Friday-only).
 * For every weekday and every candidate entry time we price a 0.15Δ strangle (DVOL IV, BS legs) and
 * hold to 07:00 IST (01:30 UTC), band-adaptive stop (3× in 35–45, else 2×). Lowest stop = that
 * weekday's best entry. Honest caveats: DVOL=30d IV; 1h bars; modelled legs.
 * Run: node scripts/fiveyear_entrytime.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri'];
const stopMult=(ivPct)=>(ivPct>=35&&ivPct<45?3:2);

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;
  // entry hours (UTC) and their IST labels; exit fixed at 01:30 UTC next day = 07:00 IST
  const ENTRIES=[[17,'22:30'],[18,'23:30'],[19,'00:30'],[20,'01:30'],[21,'02:30'],[22,'03:30']];
  const EXIT_UTC=25.5; // 01:30 UTC next day (hours from day 00:00)
  const grid={};for(let w=1;w<=5;w++){grid[w]={};for(const[h]of ENTRIES)grid[w][h]={n:0,s:0,pnl:0};}
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const anchor=new Date(d+17*HOUR).getUTCDay();if(anchor<1||anchor>5)continue;
    const ivPct=dv.get(dkey(d+17*HOUR));if(ivPct==null)continue;const iv=ivPct/100;const sm=stopMult(ivPct);
    for(const[h] of ENTRIES){
      const E=d+h*HOUR;const entry=byT.get(E);if(!entry||!(entry[3]>0))continue;
      const exitMs=d+EXIT_UTC*HOUR;if(E>=exitMs-2*HOUR)continue; // need a few hours hold
      const S0=entry[3];const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
      const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
      let stop=false,have=0;const nbars=Math.round((exitMs-E)/HOUR);
      for(let k=1;k<=nbars;k++){const b=byT.get(E+k*HOUR);if(!b)continue;have++;const T=Math.max(T0-k*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=sm*c0||bs(b[2],Kp,T,iv,'p')>=sm*p0){stop=true;break;}}
      if(have<3)continue;
      const g=grid[anchor][h];g.n++;if(stop)g.s++;
    }
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(92));
  console.log(`FIVE-YEAR ENTRY-TIME × WEEKDAY — stop% (hold to 07:00 IST, band-adaptive stop)  (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(92));
  console.log('  entry(IST):   '+ENTRIES.map(([,l])=>l.padStart(7)).join(''));
  const best={};
  for(let w=1;w<=5;w++){
    const cells=ENTRIES.map(([h])=>{const g=grid[w][h];return (g.n?pct(g.s,g.n)+'%':'—').padStart(7);});
    // best = lowest stop with n>=50
    let bh=null,bs2=999;for(const[h,l]of ENTRIES){const g=grid[w][h];if(g.n>=50&&g.s/g.n*100<bs2){bs2=g.s/g.n*100;bh=l;}}
    best[DOW[w]]=bh;
    console.log(`  ${DOW[w]}          ${cells.join('')}   ← best ${bh} (${bs2.toFixed(1)}%)`);
  }
  console.log('\n  BEST ENTRY PER WEEKDAY (5yr):  '+Object.entries(best).map(([d,t])=>`${d} ${t}`).join(' · '));
  console.log('  (later entry = past the 23:30–00:30 cascade peak, but shorter hold = less premium — this is the stop-side read.)');
  // emit for the calendar/clock
  const outObj={}; for(let w=1;w<=5;w++){const rows=ENTRIES.map(([h,l])=>({ist:l,stop:grid[w][h].n?+ (grid[w][h].s/grid[w][h].n*100).toFixed(1):null,n:grid[w][h].n}));outObj[DOW[w]]={best:best[DOW[w]],byHour:rows};}
  const fe=P('../../frontend/public/data/entry_times.js');fs.writeFileSync(fe,`window.__STRANGLE_ENTRYTIME = ${JSON.stringify(outObj)};\n`);
  console.log('\n[entry_times] wrote frontend/public/data/entry_times.js (window.__STRANGLE_ENTRYTIME).');
}
main();
