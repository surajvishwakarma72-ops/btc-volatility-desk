/**
 * FIVE-YEAR LIQUIDATION-CASCADE FOOTPRINT (honest proxy — NOT a real liquidation heatmap).
 * A liquidation heatmap needs per-level liq/OI data (live-only, ~30d free). What a strangle seller
 * actually fears is the CASCADE: a sharp forced-liquidation sweep that doubles a leg. That leaves a
 * price footprint — a fast 1h bar — which IS measurable over 5 years. We flag cascade bars
 * (1h range ≥ 2% of price) in the overnight hold, and ask: when do they cluster, and do they stop you?
 * Legs BS-modelled (DVOL IV, 0.15Δ, stop@2×). Honest caveat: this is a price proxy for cascades,
 * not a real liquidation map; DVOL=30d IV; 1h bars.
 * Run: node scripts/fiveyear_cascade.mjs
 */
import fs from 'node:fs';
const P = (u) => decodeURIComponent(new URL(u, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const HOUR = 3600_000, DAY = 86400_000, YR = 365 * DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365, CASC=2.0; // cascade = 1h range ≥ 2% of open
  const wd={},mo={},hr=new Array(9).fill(0); for(const d of[1,2,3,4,5]){wd[d]={n:0,casc:0}} for(let m=0;m<12;m++)mo[m]={n:0,casc:0};
  let total=0, cascN=0, cascStop=0, calmN=0, calmStop=0;
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry[3]>0))continue;
    const S0=entry[3],iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0,casc=false;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;
      const rng=(b[1]-b[2])/b[3]*100; if(rng>=CASC){casc=true; if(h<9)hr[h]++;}
      const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0||bs(b[2],Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;
    total++;const mi=new Date(E).getUTCMonth();
    wd[w].n++; mo[mi].n++; if(casc){wd[w].casc++;mo[mi].casc++;cascN++;if(stop)cascStop++;}else{calmN++;if(stop)calmStop++;}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(84));
  console.log(`FIVE-YEAR CASCADE FOOTPRINT — ${total} weekday nights (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(84));
  console.log(`\n1) CASCADE vs CALM nights (cascade = a ≥2% 1h sweep in the hold):`);
  console.log(`  cascade nights: ${cascN} (${pct(cascN,total)}% of nights) · stop ${pct(cascStop,cascN)}%`);
  console.log(`  calm    nights: ${calmN} (${pct(calmN,total)}%) · stop ${pct(calmStop,calmN)}%`);
  console.log('\n2) CASCADE FREQUENCY BY WEEKDAY:');
  console.log('  day   nights  cascade%');
  for(const dd of[1,2,3,4,5])console.log(`  ${DOW[dd]}  ${String(wd[dd].n).padStart(5)}   ${pct(wd[dd].casc,wd[dd].n).padStart(5)}%`);
  console.log('\n3) CASCADE FREQUENCY BY MONTH:');
  console.log('  mon   nights  cascade%');
  for(let m=0;m<12;m++)if(mo[m].n)console.log(`  ${MON[m]}  ${String(mo[m].n).padStart(5)}   ${pct(mo[m].casc,mo[m].n).padStart(5)}%`);
  console.log('\n4) WHEN IN THE NIGHT CASCADES HIT (hour from 22:30 IST entry → exit, the temporal heatmap):');
  const names=['22:30','23:30','00:30','01:30(NY/CME)','02:30','03:30','04:30','05:30(Asia)','06:30'];
  const mx=Math.max(...hr);
  for(let h=0;h<9;h++){const bar='█'.repeat(Math.round(hr[h]/mx*28));console.log(`  +${h}h ${names[h].padEnd(13)} ${String(hr[h]).padStart(4)}  ${bar}`);}
  console.log('\n  Reads: cascade nights stop far more; which weekday/month/hour the sweeps cluster = your real "heatmap".');
}
main();
