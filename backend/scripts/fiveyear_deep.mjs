/**
 * FIVE-YEAR DEEP — (A) per-weekday deep plan over 5 years and (B) the LEVELS indicator backtest
 * (day/week/month high-low position → stop rate, tagged low=danger / high=safer).
 * DVOL as IV + BS legs + band-adaptive stop + per-weekday sweet-spot entry, real prices.
 * Emits: weekday_deep.js (window.__STRANGLE_WEEKDAY_DEEP) and levels_risk.js (window.__STRANGLE_LEVELS).
 * Honest: 5-yr is modelled (DVOL=30d IV, BS legs); shows the pattern, not exact option P&L.
 * Run: node scripts/fiveyear_deep.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10),hk=(ts)=>Math.floor(ts/HOUR)*HOUR;
const ANN=Math.sqrt(24*365),DOW=['Sun','Mon','Tue','Wed','Thu','Fri'];
const stopMult=(iv)=>(iv>=35&&iv<45?3:2), mean=(a)=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN, r1=(x)=>+(+x).toFixed(1), pct=(n,d)=>d?+(n/d*100).toFixed(1):0;
const hiLo=(byT,from,to)=>{let hi=-Infinity,lo=Infinity;for(let t=from;t<=to;t+=HOUR){const b=byT.get(hk(t));if(b){if(b[1]>hi)hi=b[1];if(b[2]<lo)lo=b[2];}}return {hi,lo};};

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-full.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const dvD=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvD)dv.set(dkey(ts),v);
  const dvH=JSON.parse(fs.readFileSync(P('./btc-dvol-5y-1h.json'),'utf8'));const dvh=new Map();for(const[ts,v]of dvH)dvh.set(hk(ts),v);
  const T0=3/365;
  const byDow={1:[],2:[],3:[],4:[],5:[]};
  // levels: for day/week/month, stop & leg by position bucket
  const LV={day:{},week:{},month:{}};for(const k of['day','week','month'])for(const b of['low','mid','high'])LV[k][b]={n:0,s:0,call:0,put:0};
  const bucket=(p)=>p<0.33?'low':p<0.66?'mid':'high';
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const wd=new Date(d+17*HOUR).getUTCDay();if(wd<1||wd>5)continue;const key=dkey(d+12*HOUR);
    const ivPct=dv.get(dkey(d+17*HOUR));if(ivPct==null)continue;
    const entH=(wd===5)?19:20;const E=d+entH*HOUR,entry=byT.get(E);if(!entry||!(entry[3]>0))continue;
    const rs=[];for(let h=24;h>=1;h--){const a=byT.get(E-h*HOUR),bb=byT.get(E-(h-1)*HOUR);if(a&&bb&&a[3]>0&&bb[3]>0)rs.push(Math.log(bb[3]/a[3]));}
    if(rs.length<18)continue;const m=rs.reduce((x,y)=>x+y,0)/rs.length,sd=Math.sqrt(rs.reduce((s,x)=>s+(x-m)**2,0)/(rs.length-1)),speed=sd*ANN*100/ivPct;
    const S0=entry[3],iv=ivPct/100,sm=stopMult(ivPct);
    const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    const exitMs=d+25.5*HOUR;let stopped=false,leg='',pnlUsd=0,have=0,lastBar=entry,dvMin=dvh.get(hk(E))||ivPct;
    for(let t=E+HOUR;t<=exitMs;t+=HOUR){const bb=byT.get(t);if(!bb)continue;have++;lastBar=bb;const dvn=dvh.get(hk(t));if(dvn!=null&&dvn<dvMin)dvMin=dvn;const T=Math.max(T0-(t-E)/YR,1/365/24);
      const cHi=bs(bb[1],Kc,T,iv,'c'),pLo=bs(bb[2],Kp,T,iv,'p');
      if(cHi>=sm*c0){stopped=true;leg='call';pnlUsd=(c0+p0-(sm*c0+bs(bb[3],Kp,T,iv,'p')))*0.1-3.5;break;}
      if(pLo>=sm*p0){stopped=true;leg='put';pnlUsd=(c0+p0-(bs(bb[3],Kc,T,iv,'c')+sm*p0))*0.1-3.5;break;}}
    if(have<4)continue;
    if(!stopped){const T=Math.max(T0-(lastBar[0]-E)/YR,1/365/24);pnlUsd=(c0+p0-(bs(lastBar[3],Kc,T,iv,'c')+bs(lastBar[3],Kp,T,iv,'p')))*0.1-3.5;}
    const pnl=r1(pnlUsd/87*100),win=pnl>0,out=stopped?('SL-'+leg.toUpperCase()):(win?'TIME-WIN':'TIME-FLAT'),ivFall=r1((dvh.get(hk(E))||ivPct)-dvMin);
    // ranges
    const dR=hiLo(byT,E-DAY,E),wR=hiLo(byT,E-7*DAY,E),mR=hiLo(byT,E-30*DAY,E);
    const posD=(dR.hi>dR.lo)?(S0-dR.lo)/(dR.hi-dR.lo):0.5, posW=(wR.hi>wR.lo)?(S0-wR.lo)/(wR.hi-wR.lo):0.5, posM=(mR.hi>mR.lo)?(S0-mR.lo)/(mR.hi-mR.lo):0.5;
    for(const[k,pos]of[['day',posD],['week',posW],['month',posM]]){const g=LV[k][bucket(pos)];g.n++;if(stopped){g.s++;if(leg==='call')g.call++;else g.put++;}}
    byDow[wd].push({date:key,iv:r1(ivPct),ivFall,speed:r1(speed),out,pnl,leg:stopped?leg:'',posW:r1(posW*100)});
  }

  // (A) per-weekday deep
  const deep={};
  for(const d of[1,2,3,4,5]){const r=byDow[d];if(!r.length)continue;const stops=r.filter(x=>x.out.indexOf('SL')===0);
    const put=stops.filter(x=>x.leg==='put').length,call=stops.filter(x=>x.leg==='call').length,leg=call>=put?'call':'put';
    const wins=r.filter(x=>x.out.indexOf('SL')!==0);const avgIV=r1(mean(r.map(x=>x.iv))),winFall=r1(mean(wins.map(x=>x.ivFall))),stopFall=r1(mean(stops.map(x=>x.ivFall)));  // survived = won (theta/crush)
    const stopPos=r1(mean(stops.map(x=>x.posW))),winPos=r1(mean(wins.map(x=>x.posW))),stopSpeed=r1(mean(stops.map(x=>x.speed)));
    const improve=[
      `The ${leg.toUpperCase()} leg breaks most (${call>=put?call:put}/${stops.length} stops) — defend it: go 0.10Δ on that side when stretched, or set the ${leg} strike beyond the week ${leg==='call'?'high':'low'}.`,
      `Stops came when DVOL fell only ~${stopFall}pt vs ~${winFall}pt on wins — only sell once IV is clearly turning DOWN; a flat/rising IV is the trap.`,
      `Stops sat near the ${stopPos<45?'LOW':stopPos>60?'HIGH':'mid'} of the week range (~${stopPos}%) vs wins near ~${winPos}% — ${stopPos<winPos?'avoid selling near the week low':'watch the extremes'}.`,
      `Stops had faster tape (speed ~${stopSpeed}×) — if speed ≥ 1.5× at entry, wait for it to calm.`
    ];
    deep[DOW[d]]={n:r.length,winPct:pct(wins.length,r.length),stopPct:pct(stops.length,r.length),avgIV,leg,
      deltaRule:'0.15Δ — 0.10Δ (further OTM) if IV 40–45',stopRule:'2× — 3× if IV 35–45',
      ivNote:avgIV>=45?'rich zone — cleanest crush':avgIV>=35?'mid-band — trade at 3× stop':'calm/thin — 2×, thin premium is fine',
      ivFallToWin:winFall,improve,history:r.slice(-14).map(x=>({date:x.date,iv:x.iv,fall:x.ivFall,out:x.out,pnl:x.pnl}))};
  }

  // (B) levels indicator: stop% + leg per bucket, tagged RELATIVE (highest stop = DANGER, lowest = SAFER)
  const levels={};
  for(const k of['day','week','month']){const all=['low','mid','high'].reduce((a,b)=>a+LV[k][b].s,0),allN=['low','mid','high'].reduce((a,b)=>a+LV[k][b].n,0),base=pct(all,allN);
    const st={};for(const b of['low','mid','high'])st[b]=pct(LV[k][b].s,LV[k][b].n);
    const vals=Object.values(st),mx=Math.max(...vals),mn=Math.min(...vals),flat=(mx-mn<1.2);
    levels[k]={base};for(const b of['low','mid','high']){const g=LV[k][b];const s=st[b];
      const tag=flat?'neutral':(s===mx?'DANGER':s===mn?'SAFER':'neutral');
      levels[k][b]={n:g.n,stop:s,tag,callStop:pct(g.call,g.n),putStop:pct(g.put,g.n)};}}

  const feDir=P('../../frontend/public/data');
  fs.writeFileSync(feDir+'/weekday_deep.js',`window.__STRANGLE_WEEKDAY_DEEP = ${JSON.stringify(deep)};\n`);
  fs.writeFileSync(feDir+'/levels_risk.js',`window.__STRANGLE_LEVELS = ${JSON.stringify(levels)};\n`);
  console.log('5-YEAR DEEP:');
  for(const d of[1,2,3,4,5]){const o=deep[DOW[d]];if(o)console.log(`  ${DOW[d]}: ${o.n} nights · ${o.winPct}% win · ${o.stopPct}% stop · manage ${o.leg}`);}
  console.log('\nLEVELS (stop% by position, tagged):');
  for(const k of['day','week','month'])console.log(`  ${k}: low ${levels[k].low.stop}% (${levels[k].low.tag}) · mid ${levels[k].mid.stop}% · high ${levels[k].high.stop}% (${levels[k].high.tag})`);
  console.log('\n[fiveyear_deep] wrote weekday_deep.js + levels_risk.js');
}
main();
