/**
 * FIVE-YEAR PAST CALENDAR FILL — a per-date backtest result for every weekday night 2021→2026, so the
 * calendar shows data far into the past (not just the 1 year of real option IV). MODELLED: DVOL as IV +
 * BS legs + the gate (calm speed + not panic) + band-adaptive stop + per-weekday sweet-spot entry.
 * Emits frontend/public/data/fiveyear_days.js → window.__STRANGLE_BT_DAYS_5Y (excludes the real 1-yr span,
 * which stays authoritative in backtest_days.js). Honest: modelled, not real option prices.
 * Run: node scripts/fiveyear_calendar.mjs
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
const stopMult=(iv)=>(iv>=35&&iv<45?3:2);
const REAL_FROM='2025-10-06',REAL_TO='2026-10-17'; // the real-IV span stays authoritative

async function fetchPriceFull(){
  const CACHE=P('./btc-1h-full.json');
  if(fs.existsSync(CACHE)){const c=JSON.parse(fs.readFileSync(CACHE,'utf8'));if(c.length>48000)return c;}
  const end=Date.now();let t=1616198400000;const out=[]; // from 2021-03-20 (covers DVOL start 2021-03-24)
  while(t<end){const u=`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${t}&limit=1000`;const r=await fetch(u);const a=await r.json();if(!Array.isArray(a)||!a.length)break;
    for(const k of a)out.push([k[0],+k[2],+k[3],+k[4]]);t=a[a.length-1][0]+HOUR;if(a.length<1000)break;await new Promise(s=>setTimeout(s,110));}
  fs.writeFileSync(CACHE,JSON.stringify(out));console.log(`[price-full] ${out.length} bars ${new Date(out[0][0]).toISOString().slice(0,10)} → ${new Date(out[out.length-1][0]).toISOString().slice(0,10)}`);return out;
}

async function main(){
  const prices=await fetchPriceFull();const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;const out={};let go=0,wait=0;
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const key=dkey(d+12*HOUR);const wd=new Date(d+17*HOUR).getUTCDay();if(wd<1||wd>5)continue;
    if(key>=REAL_FROM&&key<=REAL_TO)continue; // leave the real span to backtest_days.js
    const ivPct=dv.get(key);if(ivPct==null)continue;
    const entH=(wd===5)?19:20; // Fri 00:30 IST (19:00 UTC), else 01:30 IST (20:00 UTC)
    const E=d+entH*HOUR,entry=byT.get(E);if(!entry||!(entry[3]>0))continue;
    // speed = RV24/DVOL at entry
    const rs=[];for(let h=24;h>=1;h--){const a=byT.get(E-h*HOUR),bb=byT.get(E-(h-1)*HOUR);if(a&&bb&&a[3]>0&&bb[3]>0)rs.push(Math.log(bb[3]/a[3]));}
    if(rs.length<18){continue;}
    const m=rs.reduce((x,y)=>x+y,0)/rs.length,sd=Math.sqrt(rs.reduce((s,x)=>s+(x-m)**2,0)/(rs.length-1)),rv=sd*ANN*100,speed=rv/ivPct;
    // GATE (modelled): WAIT if panic or fast tape
    if(ivPct>=65){out[key]={v:'WAIT',note:'IV ≥ 65 panic'};wait++;continue;}
    if(speed>=1.5){out[key]={v:'WAIT',note:'fast tape (speed '+speed.toFixed(1)+'×)'};wait++;continue;}
    // GO — simulate overnight to 07:00 IST (01:30 UTC next day), band-adaptive stop
    const S0=entry[3],iv=ivPct/100,sm=stopMult(ivPct);
    const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    const exitMs=d+25.5*HOUR;let stopped=false,leg='',pnlUsd=0,have=0,lastBar=entry;
    for(let t=E+HOUR;t<=exitMs;t+=HOUR){const bbar=byT.get(t);if(!bbar)continue;have++;lastBar=bbar;const T=Math.max(T0-(t-E)/YR,1/365/24);
      const cHi=bs(bbar[1],Kc,T,iv,'c'),pLo=bs(bbar[2],Kp,T,iv,'p');
      if(cHi>=sm*c0){stopped=true;leg='CALL';pnlUsd=(c0+p0-(sm*c0+bs(bbar[3],Kp,T,iv,'p')))*0.1-3.5;break;}
      if(pLo>=sm*p0){stopped=true;leg='PUT';pnlUsd=(c0+p0-(bs(bbar[3],Kc,T,iv,'c')+sm*p0))*0.1-3.5;break;}}
    if(have<4)continue;
    if(!stopped){const T=Math.max(T0-(lastBar[0]-E)/YR,1/365/24);pnlUsd=(c0+p0-(bs(lastBar[3],Kc,T,iv,'c')+bs(lastBar[3],Kp,T,iv,'p')))*0.1-3.5;}
    const pnl=+(pnlUsd/87*100).toFixed(1),win=pnl>0;
    out[key]={v:'TRADE',s:stopped,w:win,pnl,note:stopped?('SL-'+leg):(win?'TIME-WIN':'TIME-FLAT')};go++;
  }
  const fe=P('../../frontend/public/data/fiveyear_days.js');
  fs.writeFileSync(fe,`window.__STRANGLE_BT_DAYS_5Y = ${JSON.stringify(out)};\n`);
  console.log(`[fiveyear_calendar] ${go} GO + ${wait} WAIT modelled nights (2021→2025, excl. the real 1-yr span) → fiveyear_days.js`);
}
main();
