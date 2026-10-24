/**
 * RISK-ADX v2 — walk-forward research + model build.
 *
 * Question: can ONE 0–100 line (25 = the line) built from the desk's indicators tell you WHEN TO ENTER and WHEN TO EXIT a
 * short strangle (0.15Δ both legs, per-leg 2× stop, held 8 h from the entry hour, i.e. 22:30 IST → ~07:00 IST)?
 *
 * Method (everything out-of-sample = a year is scored by a model fitted only on EARLIER years):
 *   1. hourly feature table for the 10 indicators with 5-year history (price + DVOL as IV; option legs are Black-Scholes)
 *   2. candidate scorers: (A) the old weighted-percentile average  (B) ridge-logistic regression on percentile ranks
 *   3. entry samples = every weekday night at 22:30 / 23:30 / 00:30 / 01:30 IST, label = a leg is stopped within 8 h
 *   4. dynamics: stop rate by score level × 3-hour direction (the "20 falling to 0" vs "20 rising to 25" question)
 *   5. strategy test: always-enter vs speed gate vs Risk-ADX gate vs gate + exit-on-cross vs wait-for-falling entry
 * Output: console report + data/risk_model.js (window.__STRANGLE_RISKMODEL) used by the desk.
 * Caveat: DVOL is a 30-day IV proxy and legs are modelled, not real option prices.
 * Run: node scripts/fiveyear_riskadx_v2.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY,ANN=Math.sqrt(24*365);
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const sd=a=>{if(a.length<2)return null;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};

const FIXEDW={spd:Number(process.env.SPDM)||10,atm:8,spk:7,rng:6,vov:5,dchg:4,rv:3,edge:3,clk:2.5,dvol:2,adx:1.5,rsi:1,rng6:1,r6:0.5,r24:0.5,rvr:0.5};   // FIXED=1: the user's priority order, speed > ATM IV > range > VoV
const BASE10=['spd','atm','vov','rv','rng','edge','clk','dvol','adx','rsi'];
const FEATS=[...BASE10,'r6','r24','rng6','rvr','dchg','spk'];   // shipped set: the 10 + trend / recent-range / IV-change terms (walk-forward AUC 0.611 → 0.62+)
const ORDER=[['spd','IV vs speed'],['atm','ATM IV'],['vov','VoV'],['rv','RV'],['rng','Range 24'],['edge','Edge'],['clk','Tonight IV vs clock'],['dvol','DVOL'],['skew','25Δ skew'],['adx','ADX'],['rsi','RSI'],['macro','Macro stress'],['fut','Futures positioning'],['fund','Funding / OI'],['term','Term spread'],['bidask','Bid/ask spread'],['crush','IV crush driver'],['greeks','ATM greeks']];
function adxSeries(bars,per=14){const out=new Map();if(bars.length<per*2)return out;const sm={tr:0,p:0,n:0};let adx=0,dxCount=0,dxSum=0;for(let i=1;i<bars.length;i++){const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;const trv=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));const up=h-ph,dn=pl-l;const pdmv=(up>dn&&up>0)?up:0,ndmv=(dn>up&&dn>0)?dn:0;if(i<=per){sm.tr+=trv;sm.p+=pdmv;sm.n+=ndmv;continue;}sm.tr=sm.tr-sm.tr/per+trv;sm.p=sm.p-sm.p/per+pdmv;sm.n=sm.n-sm.n/per+ndmv;const pdi=100*sm.p/sm.tr,ndi=100*sm.n/sm.tr;const dx=100*Math.abs(pdi-ndi)/((pdi+ndi)||1);dxCount++;if(dxCount<per){dxSum+=dx;if(dxCount===per-1)adx=dxSum/per;}else{adx=(adx*(per-1)+dx)/per;out.set(bars[i].t,adx);}}return out;}
function rsiSeries(bars,per=14){const out=new Map();let g=0,l=0;for(let i=1;i<bars.length;i++){const d=bars[i].c-bars[i-1].c,u=Math.max(d,0),dn=Math.max(-d,0);if(i<=per){g+=u/per;l+=dn/per;if(i<per)continue;}else{g=(g*(per-1)+u)/per;l=(l*(per-1)+dn)/per;}out.set(bars[i].t,l===0?100:100-100/(1+g/l));}return out;}
const pctOf=(sorted,v)=>{let lo=0,hi=sorted.length;while(lo<hi){const m=(lo+hi)>>1;if(sorted[m]<v)lo=m+1;else hi=m;}return 100*lo/sorted.length;};
const quant=(sorted,q)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.round(q/100*(sorted.length-1))))];
function auc(pos,neg){ // P(score_pos > score_neg)
  const all=[...pos.map(s=>[s,1]),...neg.map(s=>[s,0])].sort((a,b)=>a[0]-b[0]);let rank=1,sumPos=0;for(let i=0;i<all.length;){let j=i;while(j<all.length&&all[j][0]===all[i][0])j++;const avg=(rank+rank+(j-i)-1)/2;for(let k=i;k<j;k++)if(all[k][1])sumPos+=avg;rank+=j-i;i=j;}
  return (sumPos-pos.length*(pos.length+1)/2)/(pos.length*neg.length);}

// ridge-logistic regression (Newton / IRLS) on x (n×d, already centred), y (0/1)
function fitLogit(X,y,lambda=2){
  const n=X.length,d=X[0].length;let w=new Array(d+1).fill(0);
  for(let it=0;it<30;it++){
    const H=Array.from({length:d+1},()=>new Array(d+1).fill(0)),g=new Array(d+1).fill(0);
    for(let i=0;i<n;i++){const xi=[1,...X[i]];let z=0;for(let j=0;j<=d;j++)z+=w[j]*xi[j];const p=1/(1+Math.exp(-z)),r=p-y[i],s=p*(1-p);for(let j=0;j<=d;j++){g[j]+=r*xi[j];for(let k=0;k<=d;k++)H[j][k]+=s*xi[j]*xi[k];}}
    for(let j=1;j<=d;j++){g[j]+=lambda*w[j];H[j][j]+=lambda;}H[0][0]+=1e-6;
    // solve H dw = g (Gauss)
    const A=H.map((r,i)=>[...r,g[i]]);const m=d+1;for(let c=0;c<m;c++){let p=c;for(let r=c+1;r<m;r++)if(Math.abs(A[r][c])>Math.abs(A[p][c]))p=r;[A[c],A[p]]=[A[p],A[c]];const dv=A[c][c]||1e-9;for(let k=c;k<=m;k++)A[c][k]/=dv;for(let r=0;r<m;r++){if(r===c)continue;const f=A[r][c];if(!f)continue;for(let k=c;k<=m;k++)A[r][k]-=f*A[c][k];}}
    let mx=0;for(let j=0;j<m;j++){const dw=A[j][m];w[j]-=dw;mx=Math.max(mx,Math.abs(dw));}if(mx<1e-6)break;
  }
  return w;
}

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-full.json'),'utf8'));
  const b1=prices.map(b=>({t:b[0],h:b[1],l:b[2],c:b[3]}));const byT=new Map(b1.map(b=>[b.t,b]));
  const adx=adxSeries(b1),rsi=rsiSeries(b1);
  const dv=new Map(JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8')).map(([t,v])=>[dkey(t),v]));
  const dh=new Map(JSON.parse(fs.readFileSync(P('./btc-dvol-5y-1h.json'),'utf8')));
  const ivAt=(E)=>dh.get(E)??dv.get(dkey(E))??null;
  const first=prices[0][0],last=prices[prices.length-1][0];

  /* features at any hour E (UTC ms, on the hour) */
  function featuresAt(E){
    const iv=ivAt(E);if(!(iv>0))return null;
    const w=[];for(let h=24;h>=1;h--){const a=byT.get(E-h*HOUR),b=byT.get(E-(h-1)*HOUR);if(a&&b)w.push([a,b]);}
    if(w.length<18)return null;const lr=w.map(([a,b])=>Math.log(b.c/a.c)),rv24=sd(lr)*ANN*100,r6=lr.slice(-6),rv6=r6.length>=5?sd(r6)*ANN*100:null;
    const S=byT.get(E);if(!S)return null;const hi=Math.max(...w.map(([,b])=>b.h)),lo=Math.min(...w.map(([,b])=>b.l));
    const ser=[];for(let h=24;h>=0;h--){const v=dh.get(E-h*HOUR);if(v>0)ser.push(v);}let vov=null;if(ser.length>=12){const ch=[];for(let i=1;i<ser.length;i++)ch.push(Math.log(ser[i]/ser[i-1]));vov=sd(ch)*100;}
    const d6=[];for(let h=6;h>=0;h--){const v=dh.get(E-h*HOUR);if(v>0)d6.push(v);}
    const x=adx.get(E),r=rsi.get(E);if(x==null||r==null)return null;
    const c0=byT.get(E-24*HOUR),c6=byT.get(E-6*HOUR),i24=dh.get(E-24*HOUR)??dv.get(dkey(E-24*HOUR));
    const h6=w.slice(-6),hi6=Math.max(...h6.map(([,b])=>b.h)),lo6=Math.min(...h6.map(([,b])=>b.l));
    return {spd:rv24/iv,atm:iv,vov,rv:rv6,rng:((hi-lo)/S.c*100)/(iv/Math.sqrt(365)),edge:iv-rv24,clk:d6.length>=4?iv/Math.max(...d6):null,dvol:iv,adx:x,rsi:r,
      r24:c0?Math.abs(Math.log(S.c/c0.c))*100/(iv/Math.sqrt(365)):null,r6:c6?Math.abs(Math.log(S.c/c6.c))*100/(iv/Math.sqrt(365*4)):null,rng6:((hi6-lo6)/S.c*100)/(iv/Math.sqrt(365*4)),rvr:rv6!=null?rv6/rv24:null,dchg:i24>0?iv-i24:null,
      spk:(()=>{const pre=ivAt(E-5*HOUR);let pk=null;for(let h=4;h>=1;h--){const x=dh.get(E-h*HOUR);if(x>0&&(pk==null||x>pk))pk=x;}return pre>0&&pk>0?(pk-pre)/pre*100:null;})(),
      pos:(S.c-lo)/((hi-lo)||1)};
  }
  /* strangle simulated from hour E: legs 0.15Δ at DVOL, stop 2× per leg, until E+8h. returns path info */
  function sim(E,exitH=8){
    const S0=byT.get(E);const ivp=ivAt(E);if(!S0||!(ivp>0))return null;const iv=ivp/100,T0=3/365,Kc=strikeK(S0.c,T0,iv,0.15,'c'),Kp=strikeK(S0.c,T0,iv,0.15,'p'),c0=bs(S0.c,Kc,T0,iv,'c'),p0=bs(S0.c,Kp,T0,iv,'p');if(!(c0>0)&&!(p0>0))return null;
    const cr=c0+p0,mk=[];let stopped=null,have=0;
    for(let h=1;h<=exitH;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);
      const cHi=bs(b.h,Kc,T,iv,'c'),pLo=bs(b.l,Kp,T,iv,'p');
      if(!stopped){ if(cHi>=2*c0){stopped={h,leg:'c',pnl:(cr-(2*c0+bs(b.c,Kp,T,iv,'p')))/cr*100};} else if(pLo>=2*p0){stopped={h,leg:'p',pnl:(cr-(bs(b.c,Kc,T,iv,'c')+2*p0))/cr*100};} }
      mk.push({h,pnl:stopped?stopped.pnl:(cr-(bs(b.c,Kc,T,iv,'c')+bs(b.c,Kp,T,iv,'p')))/cr*100,stopped:!!stopped});}
    if(have<exitH-2)return null;return {stopped:!!stopped,sh:stopped?stopped.h:null,final:mk[mk.length-1].pnl,mk,cr};
  }

  /* ---------- build samples: every weekday night, entry hours 17,18,19,20 UTC (22:30,23:30,00:30,01:30 IST) ---------- */
  const samples=[];
  for(let d=Math.ceil(first/DAY)*DAY;d<last-DAY;d+=DAY){
    const E0=d+17*HOUR,wd=new Date(E0).getUTCDay();if(wd<1||wd>5)continue;
    for(let k=0;k<4;k++){const E=E0+k*HOUR,f=featuresAt(E);if(!f)continue;const s=sim(E);if(!s)continue;
      const fPrev=featuresAt(E-3*HOUR);
      samples.push({E,E0,k,wd,yr:new Date(E).getUTCFullYear(),mo:new Date(E).getUTCMonth()+1,f,fPrev,stop:s.stopped,final:s.final,sim:s});}
  }
  const base=samples.filter(s=>s.stop).length/samples.length*100;
  /* ---------- the desk's own chart-pattern detectors (frontend/index.html, paLayer), run on 5 years of hourly bars ---------- */
  function loadPatternCode(){
    const t=fs.readFileSync(P('../../frontend/index.html'),'utf8'),a=t.indexOf('function atrOf(H, L, C, n)'),b=t.indexOf('function regime(R) {',a);
    const bs=t.indexOf('const PAT_BIAS = {'),be=t.indexOf('};',bs)+2;
    const code='const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));'+t.slice(a,b)+t.slice(bs,be)+';return {atrOf,pivots,structure,candlePatterns,chartPatterns,rangeBox,PAT_BIAS};';
    return new Function(code)();
  }
  const PATC=loadPatternCode(),PV=process.env.PATTERN==='1';
  const NEUTRAL=new Set(['Range','Symmetrical triangle','Broadening']);
  function patternsAt(E){
    const N=100,H=[],Lo=[],C=[],O=[];for(let h=N-1;h>=0;h--){const b=byT.get(E-h*HOUR);if(!b)return null;H.push(b.h);Lo.push(b.l);C.push(b.c);}
    for(let i=0;i<N;i++)O.push(i?C[i-1]:C[0]);
    const A=PATC.atrOf(H,Lo,C,14),piv=PATC.pivots(H,Lo,3),st=PATC.structure(piv,C),cp=PATC.candlePatterns(O,H,Lo,C,A),pats=PATC.chartPatterns(piv,O,H,Lo,C,A);
    if(!pats.some(p=>p.name==='Range'))for(const p of PATC.rangeBox(O,H,Lo,C,A))pats.push(p);
    const n=N,last=n-1;let latest=null;for(const x of pats){if(x.from>=n)continue;if(!latest||x.from>latest.from||(x.from===latest.from&&x.name==='Range'))latest=x;}
    const dirActive=pats.filter(p=>(PATC.PAT_BIAS[p.name]||0)!==0);
    const confirmedDir=dirActive.filter(p=>p.state==='confirmed'||p.dir===true);
    const breaks=(st&&st.breaks||[]).filter(b=>b.to>=last-2);
    const candles=(cp||[]).filter(c=>c.i>=last-1);
    return {latest:latest?latest.name:null,latestBias:latest?(PATC.PAT_BIAS[latest.name]||0):0,latestState:latest?latest.state:null,nDir:dirActive.length,nConfirmed:confirmedDir.length,confirmedBias:confirmedDir.length?Math.sign(confirmedDir.reduce((s,p)=>s+(PATC.PAT_BIAS[p.name]||0),0)):0,
      breakBos:breaks.some(b=>b.type==='BOS'),breakChoch:breaks.some(b=>b.type==='CHoCH'),breakDir:breaks.length?breaks[breaks.length-1].dir:0,candle:candles.length?candles[candles.length-1]:null,pats:pats.map(p=>p.name)};
  }
  for(const s of samples)s.pat=patternsAt(s.E);
  const patternRows=[];
  {
    const rowsP=patternRows;const tag=(s)=>{if(s.pat===undefined)s.pat=patternsAt(s.E);return s.pat;};
    let ok=0;for(const s of samples){const r=tag(s);if(r)ok++;}if(PV)console.log('PATTERN STUDY: samples with a pattern read',ok,'of',samples.length);
    const baseStop=samples.filter(s=>s.stop).length/samples.length*100;const st=a=>a.length?(a.filter(s=>s.stop).length/a.length*100).toFixed(1):'-',pn=a=>a.length?mean(a.map(s=>s.final)).toFixed(1):'-';
    const line=(nm,a)=>{const r={name:nm,n:a.length,stop:+st(a),pnl:+pn(a),lift:a.length?+(st(a)/baseStop).toFixed(2):null};rowsP.push(r);if(PV)console.log('  '+nm.padEnd(60)+' n '+String(a.length).padStart(5)+'  stopped '+String(r.stop).padStart(5)+'%  avg P&L '+String(r.pnl).padStart(5)+'%  x'+r.lift);};
    const S=samples.filter(s=>s.pat);if(PV)console.log('  all samples base stop '+baseStop.toFixed(1)+'%');
    line('no pattern read',S.filter(s=>!s.pat.latest));
    line('latest pattern is neutral (range / symmetrical / broadening)',S.filter(s=>s.pat.latest&&s.pat.latestBias===0));
    line('latest pattern is bullish (forming)',S.filter(s=>s.pat.latestBias>0&&s.pat.latestState!=='confirmed'));
    line('latest pattern is bearish (forming)',S.filter(s=>s.pat.latestBias<0&&s.pat.latestState!=='confirmed'));
    line('a directional pattern is CONFIRMED (bullish)',S.filter(s=>s.pat.confirmedBias>0));
    line('a directional pattern is CONFIRMED (bearish)',S.filter(s=>s.pat.confirmedBias<0));
    line('any directional pattern forming or confirmed',S.filter(s=>s.pat.nDir>0));
    line('no directional pattern at all',S.filter(s=>s.pat.nDir===0));
    line('BOS in the last 3 bars',S.filter(s=>s.pat.breakBos));
    line('CHoCH (first sign of a turn) in the last 3 bars',S.filter(s=>s.pat.breakChoch));
    line('no structure break in the last 3 bars',S.filter(s=>!s.pat.breakBos&&!s.pat.breakChoch));
    const cd=S.filter(s=>s.pat.candle);line('a candle pattern on the last 2 bars',cd);line('  of which bullish',cd.filter(s=>s.pat.candle.bias>0));line('  of which bearish',cd.filter(s=>s.pat.candle.bias<0));line('  of which neutral / doji',cd.filter(s=>!s.pat.candle.bias));
    const names={};for(const s of S)for(const nm of new Set(s.pat.pats))(names[nm]=names[nm]||[]).push(s);
    if(PV)console.log('  by pattern name (present at the entry hour):');for(const [nm,a] of Object.entries(names).sort((x,y)=>y[1].length-x[1].length))line('    '+nm,a);
    if(PV){for(const y of [2021,2022,2023,2024,2025,2026]){const a=S.filter(s=>s.yr===y&&s.pat.nDir>0),b=S.filter(s=>s.yr===y&&s.pat.nDir===0);console.log('    '+y+'  with '+st(a)+'% (n'+a.length+')  without '+st(b)+'% (n'+b.length+')');}}
    if(PV)return;
  }

  const sessions=(()=>{ // which hours of the day are sellable, and can a big move be seen coming?
    const hrs=[];for(let d=Math.ceil(first/DAY)*DAY;d<last-DAY;d+=DAY){const wd=new Date(d).getUTCDay();if(wd<1||wd>5)continue;for(let h=0;h<24;h++){const E=d+h*HOUR;const s=sim(E);if(!s)continue;const f=featuresAt(E);hrs.push({E,h,wd,s,f});}}
    console.log('SESSIONS: entry at each UTC hour (IST = UTC+5:30), Mon-Fri, 8h hold, per-leg 2x stop');
    const tab=[],det=[];for(let h=0;h<24;h++){const a=hrs.filter(x=>x.h===h);const stp=a.filter(x=>x.s.stopped).length/a.length*100,avg=mean(a.map(x=>x.s.final)),tot=a.reduce((t,x)=>t+x.s.final,0);tab.push({utc:h,ist:((h*60+330)%1440/60).toFixed(1),n:a.length,stop:+stp.toFixed(1),avg:+avg.toFixed(1)});}
    for(const r of tab)console.log('  UTC '+String(r.utc).padStart(2)+'  IST '+r.ist.padStart(4)+'  n '+r.n+'  stopped '+String(r.stop).padStart(5)+'%  avg P&L '+String(r.avg).padStart(5)+'%');
    // big move precursors: stop within the first 3 h of the hold
    const rangeAvg=(E)=>{let t=0,n=0;for(let k=1;k<=24;k++){const b=byT.get(E-k*HOUR);if(b){t+=(b.h-b.l)/b.c;n++;}}return n?t/n:null;};
    const bar=(E)=>byT.get(E-HOUR);// the hour that just closed
    const base3=hrs.filter(x=>x.s.mk.length>=3).map(x=>x.s.mk.find(m=>m.h<=3&&m.stopped)?1:0);
    const b3=mean(base3)*100;console.log('\nBIG-MOVE DETECTORS: P(a leg is stopped within 3 h of the entry hour) all hours base '+b3.toFixed(1)+'%');
    const test=(nm,fn,filter)=>{const a=hrs.filter(x=>x.f&&(!filter||filter(x))&&fn(x));const base=hrs.filter(x=>!filter||filter(x));const p=(arr)=>arr.length?arr.filter(x=>x.s.mk.find(m=>m.h<=3&&m.stopped)).length/arr.length*100:null;console.log('  '+nm.padEnd(58)+' n '+String(a.length).padStart(5)+'  stopped<=3h '+String(p(a)?.toFixed(1)).padStart(5)+'%  (base '+p(base).toFixed(1)+'%)  lift x'+(p(a)/p(base)).toFixed(2));det.push({name:nm,scope:filter?'entry hours':'all hours',n:a.length,stop3h:+p(a).toFixed(1),base:+p(base).toFixed(1),lift:+(p(a)/p(base)).toFixed(2)});};
    const ra=(x)=>{const b=bar(x.E),av=rangeAvg(x.E);return b&&av?((b.h-b.l)/b.c)/av:null;};
    for(const [lab,flt] of [['ALL HOURS',null],['ENTRY HOURS 22:30-01:30 IST (17-20 UTC)',x=>x.h>=17&&x.h<=20]]){console.log(' '+lab);
      test('last hour range >= 2x its 24h average',x=>ra(x)>=2,flt);test('last hour range >= 3x its 24h average',x=>ra(x)>=3,flt);
      test('6h range expanding: rng6 >= 1.5 and last hour range >= 1.5x',x=>x.f.rng6>=1.5&&ra(x)>=1.5,flt);
      test('squeeze then break: rng6 <= 0.5 two hours ago, last hour >= 2x',x=>{const f2=featuresAt(x.E-2*HOUR);return f2&&f2.rng6<=0.5&&ra(x)>=2;},flt);
      test('RV ratio rv6/rv24 >= 1.3',x=>x.f.rvr>=1.3,flt);
      test('IV up >= 1.5% over 2 h',x=>{const a=ivAt(x.E),b=ivAt(x.E-2*HOUR);return a&&b&&(a-b)/b*100>=1.5;},flt);
      test('speed (RV24/IV) >= 1.5',x=>x.f.spd>=1.5,flt);
      test('NOTHING unusual: speed<1, range<1.5x, rvr<1.1',x=>x.f.spd<1&&ra(x)<1.5&&x.f.rvr<1.1,flt);}
    return {hours:tab,detectors:det};})();

  /* journey features at each entry hour */
  {
    const iv1=(E)=>dh.get(E)>0?dh.get(E):null;
    const vovW=(E,n)=>{const v=[];for(let h=n;h>=0;h--){const x=iv1(E-h*HOUR);if(x)v.push(x);}if(v.length<n-1)return null;const c=[];for(let i=1;i<v.length;i++)c.push(Math.log(v[i]/v[i-1]));return sd(c)*100;};
    for(const s of samples){const E=s.E,pre=iv1(E-5*HOUR),now=iv1(E);let peak=null;for(let h=4;h>=1;h--){const x=iv1(E-h*HOUR);if(x&&(peak==null||x>peak))peak=x;}
      if(!pre||!peak||!now){s.j=null;continue;}
      const spike=(peak-pre)/pre*100,fall=(peak-now)/peak*100,hard=iv1(E-2*HOUR)?(iv1(E-2*HOUR)-now)/iv1(E-2*HOUR)*100:0;
      const v0=vovW(E,6),v2=vovW(E-2*HOUR,6),v4=vovW(E-4*HOUR,6);
      const vovDn=v0!=null&&v2!=null&&v4!=null&&v0<v2&&v2<v4, vovUp=v0!=null&&v2!=null&&v0>v2*1.05;
      s.j={spike,fall,hard,vovDn,vovUp,v0,v2,v4,pre,peak,now};}
  }
  if(process.env.RELTEST){ // does ranking against the trailing N days (instead of all 5 years) keep skill in the current, calmer regime?
    const years=[...new Set(samples.map(s=>s.yr))].sort();const W_=Number(process.env.RELTEST)||120;const sorted=samples.slice().sort((x,y)=>x.E-y.E);
    const dirOf=(train,k)=>{const A=train.filter(s=>s.stop&&s.f[k]!=null).map(s=>s.f[k]),B=train.filter(s=>!s.stop&&s.f[k]!=null).map(s=>s.f[k]);return mean(A)>=mean(B)?1:-1;};
    const res=[];
    for(const y of years){if(y<2023)continue;const train=samples.filter(s=>s.yr<y),test=sorted.filter(s=>s.yr===y);if(!test.length)continue;
      const dir=Object.fromEntries(FEATS.map(k=>[k,dirOf(train,k)]));const tabAll={};for(const k of FEATS)tabAll[k]=train.map(s=>s.f[k]).filter(x=>x!=null).sort((a,b)=>a-b);
      let lo=0;const win=[];
      for(const s of test){ // trailing window of earlier samples
        const ref=sorted.filter(t=>t.E<s.E-DAY&&t.E>=s.E-W_*DAY);
        const tabW={};for(const k of FEATS)tabW[k]=ref.map(t=>t.f[k]).filter(x=>x!=null).sort((a,b)=>a-b);
        const sc=(tab)=>{let z=0;for(const k of FEATS){const v=s.f[k];if(v==null||!tab[k].length)continue;z+=dir[k]*(FIXEDW[k]||0)*(pctOf(tab[k],v)/100-0.5);}return z;};
        s.zA=sc(tabAll);s.zW=ref.length>200?sc(tabW):s.zA;s.zB=(s.zA+s.zW)/2;}
      res.push(...test);}
    const rep=(nm,a)=>{const out=['zA','zW','zB'].map(z=>{const pos=a.filter(s=>s.stop).map(s=>s[z]),neg=a.filter(s=>!s.stop).map(s=>s[z]);return auc(pos,neg).toFixed(3);});console.log('  '+nm.padEnd(22)+'n '+String(a.length).padStart(5)+'   AUC  5y-rank '+out[0]+'   trailing-'+W_+'d '+out[1]+'   blend '+out[2]);};
    console.log('RELATIVE RANKING TEST (hand-set weights)');rep('all OOS 2023-26',res);const lastE=sorted[sorted.length-1].E;rep('last 365 nights',res.filter(s=>s.E>=lastE-365*DAY));rep('last 120 nights',res.filter(s=>s.E>=lastE-120*DAY));rep('last 60 nights',res.filter(s=>s.E>=lastE-60*DAY));
    const lastE2=sorted[sorted.length-1].E;
    console.log('\nSINGLE-FEATURE AUC (0.5 = none; >0.5 = high value precedes stops), by recency');
    const feats2=[...FEATS.map(k=>[k,s=>s.f[k]]),['spike',s=>s.j&&s.j.spike],['ivFall',s=>s.j&&s.j.fall],['iv2h',s=>s.j&&s.j.hard],['vov6',s=>s.j&&s.j.v0],['vovTrend',s=>s.j&&s.j.v0!=null&&s.j.v4?s.j.v0-s.j.v4:null]];
    for(const [nm,fn] of feats2){const r=[];for(const days of [9999,365,120,60]){const a=sorted.filter(s=>s.yr>=2023&&s.E>=lastE2-days*DAY&&fn(s)!=null);const pos=a.filter(s=>s.stop).map(fn),neg=a.filter(s=>!s.stop).map(fn);r.push(pos.length>10&&neg.length>10?auc(pos,neg).toFixed(2):' - ');}console.log('  '+nm.padEnd(9)+' all '+r[0]+'  1y '+r[1]+'  120n '+r[2]+'  60n '+r[3]);}
    return;}
  if(process.env.JOURNEY){ // study: New York fear spike -> real fall or temporary crush (judged by VoV) -> does the stage predict stops?
    const J=samples.filter(s=>s.j&&s.k===0);const st=a=>a.length?(a.filter(s=>s.stop).length/a.length*100).toFixed(1):'-',pn=a=>a.length?mean(a.map(s=>s.final)).toFixed(1):'-';
    const show=(nm,a)=>console.log('  '+nm.padEnd(58)+' n '+String(a.length).padStart(4)+'  stopped '+String(st(a)).padStart(5)+'%  P&L '+String(pn(a)).padStart(6)+'%');
    console.log('JOURNEY STUDY (entry 22:30 IST, all years) base',st(J)+'%, spike size distribution: p50',quant(J.map(s=>s.j.spike).sort((x,y)=>x-y),50).toFixed(2),'p75',quant(J.map(s=>s.j.spike).sort((x,y)=>x-y),75).toFixed(2),'p90',quant(J.map(s=>s.j.spike).sort((x,y)=>x-y),90).toFixed(2));
    for(const [lo,hi] of [[-99,0.5],[0.5,2],[2,4],[4,7],[7,99]])show('NY spike '+lo+'..'+hi+'%',J.filter(s=>s.j.spike>=lo&&s.j.spike<hi));
    const sp=s=>s.j.spike>=2;
    show('A no spike (<2%)',J.filter(s=>!sp(s)));
    show('B spike, IV still near peak (fall <1.5%)',J.filter(s=>sp(s)&&s.j.fall<1.5));
    show('C spike, IV fell >=1.5%, VoV falling steadily (real fall)',J.filter(s=>sp(s)&&s.j.fall>=1.5&&s.j.vovDn));
    show('D spike, IV fell >=1.5%, VoV rising (temporary crush)',J.filter(s=>sp(s)&&s.j.fall>=1.5&&s.j.vovUp));
    show('E spike, IV fell >=1.5%, VoV neither',J.filter(s=>sp(s)&&s.j.fall>=1.5&&!s.j.vovDn&&!s.j.vovUp));
    show('D2 IV falling hard last 2h (>=3%), VoV rising',J.filter(s=>s.j.hard>=3&&s.j.vovUp));
    show('C2 IV falling last 2h (>=0.5%), VoV falling steadily',J.filter(s=>s.j.hard>=0.5&&s.j.vovDn));
    show('VoV falling steadily (any)',J.filter(s=>s.j.vovDn));show('VoV rising (any)',J.filter(s=>s.j.vovUp));
    const conf=s=>s.f.spd<1&&s.f.adx<25&&s.f.edge>0;
    show('confirm: speed<1 & ADX<25 & edge>0',J.filter(conf));show('confirm fails',J.filter(s=>!conf(s)));
    show('C + confirm',J.filter(s=>sp(s)&&s.j.fall>=1.5&&s.j.vovDn&&conf(s)));show('D + confirm',J.filter(s=>sp(s)&&s.j.fall>=1.5&&s.j.vovUp&&conf(s)));show('A + confirm',J.filter(s=>!sp(s)&&conf(s)));
    return;}

  console.log(`samples ${samples.length} (${samples.filter(s=>s.k===0).length} nights × entry hours) base stop ${base.toFixed(1)}%`);

  /* ---------- model building from a training set ---------- */
  function buildModel(train,{logit=true,F=FEATS}={}){
    const FEATS=F;
    const tab={};for(const k of FEATS){const v=train.map(s=>s.f[k]).filter(x=>x!=null).sort((a,b)=>a-b);tab[k]=v;}
    const toX=(f)=>FEATS.map(k=>f[k]==null?0:(pctOf(tab[k],f[k])/100-0.5));   // centred percentile rank, missing = typical
    const X=train.map(s=>toX(s.f)),y=train.map(s=>s.stop?1:0);
    let w;
    if(process.env.FIXED){ // hand-set priority weights; only the direction (riskier when high or low) comes from the training data
      const dir=FEATS.map(k=>{const A=train.filter(s=>s.stop&&s.f[k]!=null).map(s=>s.f[k]),B=train.filter(s=>!s.stop&&s.f[k]!=null).map(s=>s.f[k]);return mean(A)>=mean(B)?1:-1;});
      w=[0,...FEATS.map((k,i)=>dir[i]*(FIXEDW[k]||0))];
    } else w=fitLogit(X,y,3);
    const pct=Object.fromEntries(FEATS.map(k=>[k,Array.from({length:21},(_,i)=>+quant(tab[k],i*5).toFixed(4))]));
    // old scorer (A): signed weights by mean gap, equal-ish — kept for the comparison
    return {tab,toX,w,pct,score:(f)=>{const x=toX(f);let z=w[0];for(let j=0;j<x.length;j++)z+=w[j+1]*x[j];return z;}};
  }
  function oldScorer(train){
    const tab={},o={};for(const k of FEATS){tab[k]=train.map(s=>s.f[k]).filter(x=>x!=null).sort((a,b)=>a-b);const a=train.filter(s=>s.stop&&s.f[k]!=null).map(s=>s.f[k]),b=train.filter(s=>!s.stop&&s.f[k]!=null).map(s=>s.f[k]);o[k]=mean(a)>=mean(b)?1:-1;}
    const lift=(k)=>{const v=train.filter(s=>s.f[k]!=null);const r=s=>{const p=pctOf(tab[k],s.f[k]);return o[k]>0?p:100-p;};const hot=v.filter(s=>r(s)>=70),cool=v.filter(s=>r(s)<70);if(hot.length<15||cool.length<15)return 0.5;return Math.max(0.5,(hot.filter(s=>s.stop).length/hot.length-cool.filter(s=>s.stop).length/cool.length)*100*hot.length/(hot.length+40));};
    const wt=Object.fromEntries(FEATS.map(k=>[k,lift(k)]));
    return (f)=>{let s=0,w=0;for(const k of FEATS){if(f[k]==null)continue;const p=pctOf(tab[k],f[k]);s+=(o[k]>0?p:100-p)*wt[k];w+=wt[k];}return w?s/w:null;};
  }

  /* ---------- walk-forward: score each test year with a model fitted on earlier years only ---------- */
  const years=[...new Set(samples.map(s=>s.yr))].sort();
  console.log('\nWALK-FORWARD (train on earlier years → score the next year), entry samples, label = stopped in 8 h');
  console.log('  year   n    base   AUC old-avg  AUC logistic');
  const oos=[];let aucOld=[],aucNew=[];
  for(const y of years){if(y<2023)continue;const train=samples.filter(s=>s.yr<y),test=samples.filter(s=>s.yr===y);if(train.length<500||!test.length)continue;
    const M=buildModel(train),O=oldScorer(train);
    for(const s of test){s.zNew=M.score(s.f);s.zOld=O(s.f);if(s.fPrev){s.zNewPrev=M.score(s.fPrev);s.zOldPrev=O(s.fPrev);}}
    const pos=test.filter(s=>s.stop),neg=test.filter(s=>!s.stop);
    const a1=auc(pos.map(s=>s.zOld),neg.map(s=>s.zOld)),a2=auc(pos.map(s=>s.zNew),neg.map(s=>s.zNew));aucOld.push(a1);aucNew.push(a2);
    console.log(`  ${y}  ${String(test.length).padStart(4)}  ${(pos.length/test.length*100).toFixed(1).padStart(5)}%   ${a1.toFixed(3)}        ${a2.toFixed(3)}`);
    oos.push(...test);}
  console.log(`  mean AUC  old ${mean(aucOld).toFixed(3)}  logistic ${mean(aucNew).toFixed(3)}  (0.5 = no skill)`);

  /* ---------- feature-set comparison (same walk-forward) ---------- */
  console.log('\nFEATURE SETS (mean walk-forward AUC, years 2023–2026)');
  const SETS={'base 10':BASE10,'+trend (r6,r24)':[...BASE10,'r6','r24'],'+recent range/rv ratio':[...BASE10,'rng6','rvr'],'+IV change 24h':[...BASE10,'dchg'],'+position in 24h range':[...BASE10,'pos'],'SHIPPED (10 + 5 extras)':FEATS,'core 6 (spd,rng,edge,vov,rv,adx)':['spd','rng','edge','vov','rv','adx']};
  const setAuc={};for(const [nm,F] of Object.entries(SETS)){const a=[];for(const y of years){if(y<2023)continue;const train=samples.filter(s=>s.yr<y),test=samples.filter(s=>s.yr===y);if(train.length<500||!test.length)continue;const M=buildModel(train,{F}),sc=test.map(s=>M.score(s.f));const pos=[],neg=[];test.forEach((s,i)=>(s.stop?pos:neg).push(sc[i]));a.push(auc(pos,neg));}setAuc[nm]=+mean(a).toFixed(3);console.log(`  ${nm.padEnd(34)} ${setAuc[nm]}`);}

  /* ---------- final model on all years + calibration of the 0–100 scale (25 = riskiest-30 % cut-off) ---------- */
  const FM=buildModel(samples);
  const zAll=samples.map(s=>FM.score(s.f)).sort((a,b)=>a-b);
  const cal={p5:+quant(zAll,5).toFixed(4),p70:+quant(zAll,70).toFixed(4),p100:+quant(zAll,100).toFixed(4)};
  const toScore=(z)=>z<=cal.p70?25*Math.max(0,z-cal.p5)/(cal.p70-cal.p5):25+75*Math.min(1,(z-cal.p70)/(cal.p100-cal.p70));
  // OOS scores on the 0-100 scale: each test year uses ITS OWN training calibration (the cut-offs of the model fitted before it)
  for(const y of years){if(y<2023)continue;const train=samples.filter(s=>s.yr<y);if(train.length<500)continue;const M=buildModel(train),zz=train.map(s=>M.score(s.f)).sort((a,b)=>a-b);const c={p5:quant(zz,5),p70:quant(zz,70),p100:quant(zz,100)};const f=(z)=>z<=c.p70?25*Math.max(0,z-c.p5)/(c.p70-c.p5):25+75*Math.min(1,(z-c.p70)/(c.p100-c.p70));for(const s of samples.filter(s=>s.yr===y)){s.sc=f(s.zNew);if(s.zNewPrev!=null)s.scPrev=f(s.zNewPrev);}}
  const O=samples.filter(s=>s.sc!=null);
  const st=a=>a.length?+(a.filter(s=>s.stop).length/a.length*100).toFixed(1):null,pn=a=>a.length?+mean(a.map(s=>s.final)).toFixed(1):null;
  console.log(`\nOUT-OF-SAMPLE entry samples ${O.length} (years ≥ 2023). stopped% / mean P&L % of credit by Risk-ADX band`);
  const bands=[[0,10],[10,15],[15,20],[20,25],[25,35],[35,50],[50,101]],bandRows=[];
  for(const [lo,hi] of bands){const a=O.filter(s=>s.sc>=lo&&s.sc<hi);bandRows.push({lo,hi:Math.min(hi,100),n:a.length,stop:st(a),pnl:pn(a)});console.log(`  ${String(lo).padStart(2)}–${String(Math.min(hi,100)).padEnd(3)}  n ${String(a.length).padStart(4)}  stopped ${String(st(a)).padStart(5)}%   mean P&L ${String(pn(a)).padStart(6)}%`);}
  const above=O.filter(s=>s.sc>25),below=O.filter(s=>s.sc<=25);
  console.log(`  >25  : n ${above.length} stopped ${st(above)}% P&L ${pn(above)}%   ≤25: n ${below.length} stopped ${st(below)}% P&L ${pn(below)}%`);

  /* ---------- does green hold up in every regime / recently? ---------- */
  console.log('\nREGIME CHECK (OOS): stopped% when Risk-ADX ≤25 vs >25, by DVOL level and by recency');
  const regimes=[['DVOL < 45',s=>s.f.dvol<45],['DVOL 45–60',s=>s.f.dvol>=45&&s.f.dvol<60],['DVOL ≥ 60',s=>s.f.dvol>=60],['last 120 nights',s=>s.E>=samples[samples.length-1].E-120*DAY],['last 60 nights',s=>s.E>=samples[samples.length-1].E-60*DAY],['Fridays',s=>s.wd===5],['Mon–Thu',s=>s.wd<5]];
  const regimeRows=[];for(const [nm,fn] of regimes){const a=O.filter(fn),lo=a.filter(s=>s.sc<=25),hi=a.filter(s=>s.sc>25);regimeRows.push({name:nm,calm:{n:lo.length,stop:st(lo),pnl:pn(lo)},risky:{n:hi.length,stop:st(hi),pnl:pn(hi)}});console.log(`  ${nm.padEnd(16)} ≤25: n${String(lo.length).padStart(4)} stopped ${String(st(lo)).padStart(5)}% pnl ${String(pn(lo)).padStart(5)}%   >25: n${String(hi.length).padStart(4)} stopped ${String(st(hi)).padStart(5)}% pnl ${String(pn(hi)).padStart(5)}%`);}

  /* ---------- dynamics: level × 3-hour direction ---------- */
  console.log('\nDYNAMICS (OOS): level now × direction over the last 3 h — stopped% / mean P&L% / n');
  const dyn=[];const lev=[[0,10,'0–10'],[10,20,'10–20'],[20,25,'20–25'],[25,40,'25–40'],[40,101,'40+']];
  const dir=(s)=>s.scPrev==null?null:(s.sc-s.scPrev>=2?'rising':s.sc-s.scPrev<=-2?'falling':'flat');
  for(const [lo,hi,lab] of lev){const row={level:lab};for(const dn of ['falling','flat','rising']){const a=O.filter(s=>s.sc>=lo&&s.sc<hi&&dir(s)===dn);row[dn]={n:a.length,stop:st(a),pnl:pn(a)};}dyn.push(row);
    console.log(`  ${lab.padEnd(6)} falling ${String(row.falling.stop).padStart(5)}% ${String(row.falling.pnl).padStart(6)}% (n${row.falling.n})   flat ${String(row.flat.stop).padStart(5)}% ${String(row.flat.pnl).padStart(6)}% (n${row.flat.n})   rising ${String(row.rising.stop).padStart(5)}% ${String(row.rising.pnl).padStart(6)}% (n${row.rising.n})`);}

  /* ---------- strategy test (OOS years), entry at 22:30 IST unless stated ---------- */
  console.log('\nSTRATEGY TEST (OOS ≥2023, one trade per night max, hold to 07:00 IST, per-leg 2× stop; P&L in % of credit)');
  const nights=new Map();for(const s of O){let a=nights.get(s.E0);if(!a){a=[];nights.set(s.E0,a);}a.push(s);}
  const res=[];function report(name,pick){const T=[];for(const [E0,a] of nights){a.sort((x,y)=>x.k-y.k);const t=pick(a);if(t)T.push(t);}
    const n=nights.size,w=T.filter(t=>t.pnl>0).length,stp=T.filter(t=>t.stopped).length;const tot=T.reduce((x,t)=>x+t.pnl,0);
    const r={name,nights:n,trades:T.length,win:T.length?+(w/T.length*100).toFixed(1):null,stop:T.length?+(stp/T.length*100).toFixed(1):null,avg:T.length?+(tot/T.length).toFixed(1):null,total:+tot.toFixed(0),worst:T.length?+Math.min(...T.map(t=>t.pnl)).toFixed(0):null};res.push(r);
    console.log(`  ${name.padEnd(54)} trades ${String(r.trades).padStart(3)}/${n}  win ${String(r.win).padStart(5)}%  stopped ${String(r.stop).padStart(5)}%  avg ${String(r.avg).padStart(6)}%  total ${String(r.total).padStart(6)}  worst ${r.worst}`);}
  const trade=(s,exitAfterCross=false)=>{ // trade entered at s; optional exit at the first hour the score is >25 and was ≤25 at entry
    const sm=s.sim;if(!exitAfterCross)return {pnl:sm.final,stopped:sm.stopped};
    for(const m of sm.mk){if(m.stopped)break;const E=s.E+m.h*HOUR,f=featuresAt(E);if(!f)continue;const z=FMforYear(s.yr).score(f),sc=FMforYear(s.yr).toScore(z);if(sc>25&&s.sc<=25)return {pnl:m.pnl,stopped:false,exited:m.h};}
    return {pnl:sm.final,stopped:sm.stopped};};
  const fmCache={};function FMforYear(y){if(fmCache[y])return fmCache[y];const train=samples.filter(s=>s.yr<y),M=buildModel(train),zz=train.map(s=>M.score(s.f)).sort((a,b)=>a-b),c={p5:quant(zz,5),p70:quant(zz,70),p100:quant(zz,100)};return fmCache[y]={score:M.score,toScore:(z)=>z<=c.p70?25*Math.max(0,z-c.p5)/(c.p70-c.p5):25+75*Math.min(1,(z-c.p70)/(c.p100-c.p70))};}
  report('A. always sell at 22:30 IST',a=>{const s=a.find(x=>x.k===0);return s?trade(s):null;});
  report('B. speed gate only (RV/IV < 1.5)',a=>{const s=a.find(x=>x.k===0);return s&&s.f.spd<1.5?trade(s):null;});
  report('C. Risk-ADX ≤ 25 at 22:30',a=>{const s=a.find(x=>x.k===0);return s&&s.sc<=25?trade(s):null;});
  report('D. Risk-ADX ≤ 20 at 22:30',a=>{const s=a.find(x=>x.k===0);return s&&s.sc<=20?trade(s):null;});
  report('E. speed gate + Risk-ADX ≤ 25 at 22:30',a=>{const s=a.find(x=>x.k===0);return s&&s.f.spd<1.5&&s.sc<=25?trade(s):null;});
  report('F. C + exit when Risk-ADX crosses above 25',a=>{const s=a.find(x=>x.k===0);return s&&s.sc<=25?trade(s,true):null;});
  report('G. first hour 22:30–01:30 with Risk-ADX ≤ 25',a=>{const s=a.find(x=>x.sc<=25);return s?trade(s):null;});
  report('H. first hour with Risk-ADX ≤ 25 AND falling',a=>{const s=a.find(x=>x.sc<=25&&x.scPrev!=null&&x.sc<x.scPrev);return s?trade(s):null;});
  report('I. first hour with Risk-ADX ≤ 20',a=>{const s=a.find(x=>x.sc<=20);return s?trade(s):null;});

  /* ---------- exit study: nights entered ≤25 at 22:30: after each hour, risk of a stop in the rest of the hold ---------- */
  console.log('\nEXIT STUDY (OOS): trades entered at ≤25. At hour h after entry, still open, by Risk-ADX now → stopped LATER? / pnl if closed now vs held');
  const exitRows=[];
  for(const h of [1,2,3,4,5,6]){const rows=[];for(const [E0,a] of nights){const s=a.find(x=>x.k===0);if(!s||s.sc>25)continue;const m=s.sim.mk.find(q=>q.h===h);if(!m||m.stopped)continue;const f=featuresAt(s.E+h*HOUR);if(!f)continue;const F=FMforYear(s.yr),sc=F.toScore(F.score(f));rows.push({sc,laterStop:s.stop,now:m.pnl,final:s.sim.final});}
    const hi=rows.filter(r=>r.sc>25),lo=rows.filter(r=>r.sc<=25),g=(a,fn)=>a.length?+mean(a.map(fn)).toFixed(1):null,sp=a=>a.length?+(a.filter(r=>r.laterStop).length/a.length*100).toFixed(1):null;
    exitRows.push({h,above:{n:hi.length,laterStop:sp(hi),closeNow:g(hi,r=>r.now),held:g(hi,r=>r.final)},below:{n:lo.length,laterStop:sp(lo),closeNow:g(lo,r=>r.now),held:g(lo,r=>r.final)}});
    console.log(`  +${h}h  score>25: n${String(hi.length).padStart(3)} stopped-later ${String(sp(hi)).padStart(5)}% close-now ${String(g(hi,r=>r.now)).padStart(6)}% held ${String(g(hi,r=>r.final)).padStart(6)}%   | ≤25: n${String(lo.length).padStart(3)} stopped-later ${String(sp(lo)).padStart(5)}% held ${String(g(lo,r=>r.final)).padStart(6)}%`);}

  /* ---------- the trader's journey: NY fear spike -> real fall / temporary crush (VoV) -> chart confirmation -> GO ---------- */
  const stageOf=(s)=>{const j=s.j;if(!j)return null;if(j.spike<2)return 'calm';if(j.fall<1.5)return 'holding';if(j.vovDn||j.hard>=0.5&&!j.vovUp)return 'real';if(j.hard>=3&&j.vovUp)return 'crush';return 'mixed';};
  const confirmN=(s)=>[s.f.spd<1,s.f.adx<25,s.f.rv<s.f.atm,s.f.edge>0].filter(Boolean).length;
  const dirOf2=(s)=>s.scPrev==null?null:(s.sc-s.scPrev>=2?'rising':s.sc-s.scPrev<=-2?'falling':'flat');
  const isGo=(s)=>s.sc<=25&&stageOf(s)!=='holding'&&dirOf2(s)!=='rising'&&confirmN(s)>=3;
  console.log('\nJOURNEY (OOS, all entry hours): stage -> stopped% / P&L% / n');
  const stageRows=[];for(const [id,lab] of [['calm','no NY fear spike (<2%)'],['holding','fear spike, IV still near its peak'],['real','IV fading, VoV falling = real fall'],['crush','IV falling hard, VoV rising = temporary crush?'],['mixed','spike, mixed signals']]){const a=O.filter(x=>stageOf(x)===id);stageRows.push({id,label:lab,n:a.length,stop:st(a),pnl:pn(a)});console.log('  '+lab.padEnd(48)+' n '+String(a.length).padStart(4)+'  stopped '+String(st(a)).padStart(5)+'%  P&L '+String(pn(a)).padStart(6)+'%');}
  const confRows=[0,1,2,3,4].map(c=>{const a=O.filter(x=>confirmN(x)===c);console.log('  chart confirms '+c+'/4 (speed<1, ADX<25, RV<IV, edge>0)  n '+a.length+'  stopped '+st(a)+'%  P&L '+pn(a)+'%');return {confirms:c,n:a.length,stop:st(a),pnl:pn(a)};});
  const goA=O.filter(isGo),noA=O.filter(x=>!isGo(x));console.log('  GO (<=25, no fear holding, not rising, >=3/4 confirm): n '+goA.length+' stopped '+st(goA)+'% P&L '+pn(goA)+'%   NOT GO: n '+noA.length+' stopped '+st(noA)+'% P&L '+pn(noA)+'%');
  const goN=[];for(const [E0,a] of nights){a.sort((x,y)=>x.k-y.k);const t=a.find(isGo);if(t)goN.push(t);}console.log('  first GO hour of each night (22:30-01:30 IST): trades '+goN.length+'/'+nights.size+' stopped '+st(goN)+'% avg '+pn(goN)+'% total '+goN.reduce((x,t)=>x+t.final,0).toFixed(0));
  const journey={stages:stageRows,confirms:confRows,go:{n:goA.length,stop:st(goA),pnl:pn(goA)},notGo:{n:noA.length,stop:st(noA),pnl:pn(noA)},nightly:{trades:goN.length,nights:nights.size,stop:st(goN),avg:pn(goN),total:+goN.reduce((x,t)=>x+t.final,0).toFixed(0)}};

  /* ---------- the Entry Gauge: one RSI-style line, 0 (GO) .. 100 (WAIT) ---------- */
  const GW={spd:Number(process.env.SPDG)||10,model:8,fear:7,rise:4,vov:5,rv:3,edge:3,adx:1.5};const GWT=Object.values(GW).reduce((a,b)=>a+b,0);const PRIM=['spd','model','fear','rise','vov'],SEC=['rv','edge','adx'];
  const ivx=(E)=>dh.get(E)>0?dh.get(E):null;
  const vovx=(E)=>{const v=[];for(let h=6;h>=0;h--){const x=ivx(E-h*HOUR);if(x)v.push(x);}if(v.length<5)return null;const c=[];for(let i=1;i<v.length;i++)c.push(Math.log(v[i]/v[i-1]));return sd(c)*100;};
  const gMemo=new Map();
  function gaugeBase(E,F,yr){
    const key=yr+'|'+E;if(gMemo.has(key))return gMemo.get(key);let out=null;
    const f=featuresAt(E);if(f){const sc=F.toScore(F.score(f));const fp=featuresAt(E-3*HOUR),scp=fp?F.toScore(F.score(fp)):null;
      const pre=ivx(E-5*HOUR),now=ivx(E);let pk=null;for(let h=4;h>=1;h--){const x=ivx(E-h*HOUR);if(x&&(pk==null||x>pk))pk=x;}
      let stage='unknown',vovUp=false,spike=0;
      if(pre&&pk&&now){spike=(pk-pre)/pre*100;const fall=(pk-now)/pk*100,x2=ivx(E-2*HOUR),hard=x2?(x2-now)/x2*100:0,v0=vovx(E),v2=vovx(E-2*HOUR),v4=vovx(E-4*HOUR);
        const vovDn=v0!=null&&v2!=null&&v4!=null&&v0<v2&&v2<v4;vovUp=v0!=null&&v2!=null&&v0>v2*1.05;
        stage=spike<2?'calm':fall<1.5?'holding':(vovDn||(hard>=0.5&&!vovUp))?'real':(hard>=3&&vovUp)?'crush':'mixed';}
      const ok={spd:f.spd<1,model:sc<=25,fear:stage!=='holding'&&stage!=='unknown',rise:scp==null||sc-scp<2,vov:!(stage==='crush'||(vovUp&&spike>=2)),rv:f.rv<f.atm,edge:f.edge>0,adx:f.adx<25};
      let failW=0;for(const k of Object.keys(GW))if(!ok[k])failW+=GW[k];
      /* momentum of the indicators over 2 h: building = realised-vol ratio, 6 h range and IV all accelerating (and VoV rising); exhausted = a hot reading now cooling in all of them */
      const f2=featuresAt(E-2*HOUR),iv2=ivx(E-2*HOUR);let build=0,exhaust=0;
      if(f2&&iv2&&now){const ivCh=(now-iv2)/iv2*100;
        const b=[f.rvr!=null&&f2.rvr!=null&&f.rvr>f2.rvr*1.15,f.rng6>f2.rng6*1.2,ivCh>=0.7,vovUp];build=b.filter(Boolean).length/4;
        const hot=(f2.rvr!=null&&f2.rvr>1.0)||f2.rng6>1.2,e=[f.rvr!=null&&f2.rvr!=null&&f.rvr<f2.rvr*0.85,f.rng6<f2.rng6*0.8,ivCh<=-0.7];exhaust=hot?e.filter(Boolean).length/3:0;}
      const cl=x=>Math.max(0,Math.min(1,x));
      const soft={spd:cl((f.spd-0.9)/0.2),model:cl((sc-20)/10),fear:(stage==='holding'||stage==='unknown')?1:0,rise:scp==null?0:cl((sc-scp-1)/2),vov:(stage==='crush'||(vovUp&&spike>=2))?1:0,rv:cl((f.rv/f.atm-0.9)/0.2),edge:cl((1-f.edge)/2),adx:cl((f.adx-22)/6)};
      let ra=null;{const b1=byT.get(E-HOUR);let t=0,n=0;for(let k=1;k<=24;k++){const b=byT.get(E-k*HOUR);if(b){t+=(b.h-b.l)/b.c;n++;}}if(b1&&n)ra=((b1.h-b1.l)/b1.c)/(t/n);}
      const pt=patternsAt(E);
      out={bear:!!pt&&pt.confirmedBias<0,soft,rr:ra,spike,E,sc,stage,ok,failW,veto:stage==='holding'||f.spd>=1.5||sc>50,spd:f.spd,build,exhaust,primPass:PRIM.every(k=>ok[k]),secFail:SEC.filter(k=>!ok[k]).length,allPass:failW===0};}
    gMemo.set(key,out);return out;
  }
  const VARIANTS={
    V0:{name:'V0 plain (floor 34, green = every check)',mom:false,floor:true,tol:false},
    V1:{name:'V1 = V0 + momentum',mom:true,floor:true,tol:false},
    V2:{name:'V2 continuous, green = 5 main checks + at most 1 minor',mom:false,floor:false,tol:true},
    V3:{name:'V3 = V2 + momentum',mom:true,floor:false,tol:true},
    V5:{name:'V5 smooth: soft checks, EMA, hysteresis, 2-hour confirmation for green',soft:true,burst:false},
    V6:{name:'V6 = V5 + big-move burst (hour range >= 2x: +15, >= 3x: red)',soft:true,burst:true},
    V7:{name:'V7 = V6 + confirmed bearish chart pattern (+20 and no green)',soft:true,burst:true,pat:true},
    V8:{name:'V8 = V7 + a rising line turns red (level up 4+ in 1 h or 8+ in 3 h, from 20 up)',soft:true,burst:true,pat:true,rise:true,rise1:4,rise3:8,latch:0},
    V9:{name:'V9 = rising red: 3 h change 10+ only, red held 2 more hours',soft:true,burst:true,pat:true,rise:true,rise1:0,rise3:10,latch:2},
    V10:{name:'V10 = rising red: 3 h change 15+ only, red held 2 more hours',soft:true,burst:true,pat:true,rise:true,rise1:0,rise3:15,latch:2}};
  function gaugeSeriesSoft(E0,F,yr,V){
    const out=[];let L=null,state='yellow',gcnt=0,hold=0;const Lh=[];
    for(let h=-6;h<=10;h++){const b=gaugeBase(E0+h*HOUR,F,yr);if(!b)continue;
      let failS=0;for(const k of Object.keys(GW))failS+=GW[k]*b.soft[k];
      let raw=100*(0.65*failS/GWT+0.35*Math.min(1,b.sc/50));
      if(V.burst&&b.rr!=null){if(b.rr>=3)raw=Math.max(raw,80);else if(b.rr>=2)raw+=15;}
      if(V.pat&&b.bear)raw+=20;
      if(b.veto)raw=Math.max(raw,80);raw=Math.min(100,raw);
      L=L==null?raw:L+(raw-L)*(raw>L?0.7:0.3);
      const primOK=PRIM.every(k=>b.soft[k]<0.5)&&!b.veto&&!(V.pat&&b.bear),minorBad=SEC.filter(k=>b.soft[k]>=0.5).length;
      if(state==='red'){if(L<55)state='yellow';}else if(L>=66)state='red';
      if(state==='green'){if(L>42||!primOK)state='yellow';gcnt=0;}
      else if(state==='yellow'){if(L<30&&primOK&&minorBad<=1){gcnt++;if(gcnt>=2){state='green';gcnt=0;}}else gcnt=0;}
      else gcnt=0;
      Lh.push(L);let rising=V.rise&&L>=20&&((V.rise1&&Lh.length>=2&&L-Lh[Lh.length-2]>=V.rise1)||(Lh.length>=4&&L-Lh[Lh.length-4]>=V.rise3));
      if(V.rise){if(rising)hold=V.latch||0;else if(hold>0){hold--;rising=L>=20;}}
      out.push({E:b.E,h,L,raw,sc:b.sc,stage:b.stage,build:b.build,exhaust:b.exhaust,rising:!!rising,color:rising&&state!=='red'?'red':state});}
    return out;
  }
  function gaugeSeries(E0,F,yr,V){
    if(V.soft)return gaugeSeriesSoft(E0,F,yr,V);
    const out=[];let L=null,better=0;
    for(let h=-6;h<=10;h++){const b=gaugeBase(E0+h*HOUR,F,yr);if(!b)continue;
      let raw=100*(0.65*b.failW/GWT+0.35*Math.min(1,b.sc/50));
      if(V.floor&&b.failW>0)raw=Math.max(raw,34);if(b.veto)raw=Math.max(raw,80);
      if(V.mom&&b.build>=0.5)raw=Math.min(100,Math.max(raw,(L==null?raw:L)+25*b.build));
      if(L==null){L=raw;better=0;}else if(raw>=L){L=raw;better=0;}else if(V.mom&&b.exhaust>=2/3){L=raw;better=0;}else{better++;if(better>=2)L=raw;}
      const greenOk=V.tol?(b.primPass&&b.secFail<=1&&!b.veto):b.allPass;
      out.push({E:b.E,h,L,raw,sc:b.sc,stage:b.stage,ok:b.ok,build:b.build,exhaust:b.exhaust,color:L>=66?'red':(L<34&&greenOk)?'green':'yellow'});}
    return out;
  }
  /* which single check matters: pass rate, and stopped % when only that one fails */
  {const bs=O.map(s=>gaugeBase(s.E,FMforYear(s.yr),s.yr)).filter(Boolean);const rowsC=[];for(const k of Object.keys(GW)){const f=bs.filter(b=>!b.ok[k]);rowsC.push(k+' pass '+((1-f.length/bs.length)*100).toFixed(0)+'%');}console.log('\nCHECK PASS RATES (entry hours, OOS):',rowsC.join(' | '));}
  const gauge={variants:{}};const crossBy={};
  const dvAt=(s)=>s.f.dvol;
  for(const [vk,V] of Object.entries(VARIANTS)){
    const gSeries=new Map(),share={red:0,yellow:0,green:0,n:0},entry={red:0,yellow:0,green:0,n:0};
    for(const [E0,a] of nights){const yr=a[0].yr;const F=FMforYear(yr);const S=gaugeSeries(E0,F,yr,V);if(!S.length)continue;gSeries.set(E0,S);for(const p of S){share[p.color]++;share.n++;}for(const s of a){const p=S.find(q=>q.E===s.E);s['g_'+vk]=p||null;if(p){entry[p.color]++;entry.n++;}}}
    const G=O.filter(s=>s['g_'+vk]);const gk=(s)=>s['g_'+vk];
    const zones=['red','yellow','green'].map(c=>{const a=G.filter(s=>gk(s).color===c);return {color:c,n:a.length,stop:st(a),pnl:pn(a),shareAll:+(share[c]/share.n*100).toFixed(1),shareEntry:+(entry[c]/entry.n*100).toFixed(1)};});
    let chg=0,nn=0;for(const [E0,S] of gSeries){let c=0;for(let i=1;i<S.length;i++)if(S[i].color!==S[i-1].color)c++;chg+=c;nn++;}const flick=+(chg/nn).toFixed(2);
    const aucAll=auc(G.filter(s=>s.stop).map(s=>gk(s).L),G.filter(s=>!s.stop).map(s=>gk(s).L));
    const split=(fn)=>{const a=G.filter(fn);const g=a.filter(s=>gk(s).color==='green'),r=a.filter(s=>gk(s).color==='red');return {n:a.length,green:{n:g.length,stop:st(g)},red:{n:r.length,stop:st(r)},auc:+auc(a.filter(s=>s.stop).map(s=>gk(s).L),a.filter(s=>!s.stop).map(s=>gk(s).L)).toFixed(3)};};
    const tr=split(s=>s.yr<=2024),va=split(s=>s.yr>=2025);
    console.log('\n=== '+V.name+' ===  colour changes per night '+flick+'  AUC '+aucAll.toFixed(3)+'   tune(2023-24) green '+tr.green.stop+'% (n'+tr.green.n+') red '+tr.red.stop+'% (n'+tr.red.n+') AUC '+tr.auc+'   validate(2025-26) green '+va.green.stop+'% (n'+va.green.n+') red '+va.red.stop+'% (n'+va.red.n+') AUC '+va.auc);
    for(const z of zones)console.log('  '+z.color.padEnd(7)+' n '+String(z.n).padStart(4)+'  stopped '+String(z.stop).padStart(5)+'%  P&L '+String(z.pnl).padStart(6)+'%  share of all hours '+z.shareAll+'%  of entry hours '+z.shareEntry+'%');
    const res=[];const rep2=(name,pick,arr)=>{const T=[];for(const [E0,a] of (arr||nights)){a.sort((x,y)=>x.k-y.k);const t=pick(a);if(t)T.push(t);}const tot=T.reduce((x,t)=>x+t.final,0);const r={name,nights:(arr||nights).size,trades:T.length,stop:T.length?st(T):null,avg:T.length?pn(T):null,total:+tot.toFixed(0)};res.push(r);console.log('  '+name.padEnd(46)+' trades '+String(r.trades).padStart(3)+'/'+r.nights+'  stopped '+String(r.stop).padStart(5)+'%  avg '+String(r.avg).padStart(5)+'%  total '+String(r.total).padStart(6));return T;};
    rep2('first green hour 22:30-01:30',a=>a.find(x=>gk(x)&&gk(x).color==='green'));
    rep2('not red at 22:30',a=>{const s=a.find(x=>x.k===0);return s&&gk(s)&&gk(s).color!=='red'?s:null;});
    const lastE0=Math.max(...nights.keys()),n30=new Map([...nights].filter(([E0])=>E0>lastE0-30*DAY));
    const r30a=rep2('  last 30 days: first green hour',a=>a.find(x=>gk(x)&&gk(x).color==='green'),n30);
    rep2('  last 30 days: not red at 22:30',a=>{const s=a.find(x=>x.k===0);return s&&gk(s)&&gk(s).color!=='red'?s:null;},n30);
    if(vk==='V6'||vk==='V7'){const cr=crossBy[vk]=[];const G2=G.filter(s=>s.pat);const f=(nm,a)=>{cr.push({name:nm,n:a.length,stop:st(a),pnl:pn(a)});console.log('  '+nm.padEnd(60)+' n '+String(a.length).padStart(4)+'  stopped '+String(st(a)).padStart(5)+'%  P&L '+String(pn(a)).padStart(5)+'%');};
      console.log('\nCHART PATTERNS INSIDE THE GAUGE COLOURS (V6, out-of-sample 2023-26)');
      for(const c of ['green','yellow','red']){const a=G2.filter(s=>gk(s).color===c);f(c+' · all',a);f(c+' · + confirmed bearish pattern',a.filter(s=>s.pat.confirmedBias<0));f(c+' · + confirmed bullish pattern',a.filter(s=>s.pat.confirmedBias>0));f(c+' · + rising wedge or double top present',a.filter(s=>s.pat.pats.some(n=>/Rising wedge|Double top/.test(n))));f(c+' · + CHoCH in the last 3 bars',a.filter(s=>s.pat.breakChoch));}
      console.log('  AUC of the gauge level, plus points added when a confirmed bearish pattern is present:');for(const w of [0,5,10,20,30]){const sc=s=>gk(s).L+w*(s.pat.confirmedBias<0?1:0);console.log('    +'+w+' -> AUC '+auc(G2.filter(s=>s.stop).map(sc),G2.filter(s=>!s.stop).map(sc)).toFixed(3));}
      console.log('  AUC with bullish confirmed subtracting points:');for(const w of [5,10,20]){const sc=s=>gk(s).L-w*(s.pat.confirmedBias>0?1:0);console.log('    -'+w+' -> AUC '+auc(G2.filter(s=>s.stop).map(sc),G2.filter(s=>!s.stop).map(sc)).toFixed(3));}
      const yr=(fn)=>[2023,2024,2025,2026].map(y=>{const a=G2.filter(s=>s.yr===y&&fn(s));return y+':'+st(a)+'%(n'+a.length+')';}).join(' ');console.log('  by year, confirmed bearish: '+yr(s=>s.pat.confirmedBias<0));console.log('  by year, confirmed bullish: '+yr(s=>s.pat.confirmedBias>0));console.log('  by year, no confirmed pattern: '+yr(s=>s.pat.confirmedBias===0));}
    if(vk==='V7'){const dl=(s,h)=>{const S=gSeries.get(s.E0),q=S&&S.find(x=>x.E===s.E-h*HOUR);return q&&gk(s)?gk(s).L-q.L:null;};
      const R=G.map(s=>({s,d1:dl(s,1),d2:dl(s,2),d3:dl(s,3)})).filter(x=>x.d3!=null);
      const f=(nm,a)=>console.log('  '+nm.padEnd(64)+' n '+String(a.length).padStart(4)+'  stopped '+String(st(a.map(x=>x.s))).padStart(5)+'%  P&L '+String(pn(a.map(x=>x.s))).padStart(5)+'%');
      console.log('RISING LINE (V7, out-of-sample): change of the gauge level over the last 1 / 2 / 3 hours');
      for(const [lab,k] of [['1 h','d1'],['2 h','d2'],['3 h','d3']])for(const th of [4,8,12,20]){f('rising: level up '+th+'+ points in '+lab,R.filter(x=>x[k]>=th));}
      f('falling: level down 8+ points in 3 h',R.filter(x=>x.d3<=-8));f('flat: within +-8 points over 3 h',R.filter(x=>Math.abs(x.d3)<8));
      for(const c of ['green','yellow','red']){const a=R.filter(x=>gk(x.s).color===c);f(c+' · all',a);f(c+' · and rising 8+ in 3 h',a.filter(x=>x.d3>=8));f(c+' · and rising 4+ in 1 h',a.filter(x=>x.d1>=4));f(c+' · and not rising',a.filter(x=>x.d3<8&&x.d1<4));}
      const sc=(w)=>x=>gk(x.s).L+w*(x.d3>=8?1:0);console.log('  AUC of the level, plus points when rising 8+ in 3 h:');for(const w of [0,10,20,30])console.log('    +'+w+' -> '+auc(R.filter(x=>x.s.stop).map(sc(w)),R.filter(x=>!x.s.stop).map(sc(w))).toFixed(3));}
    gauge.variants[vk]={name:V.name,flicker:flick,auc:+aucAll.toFixed(3),tune:tr,validate:va,zones,strategies:res};
    if(vk==='V3'||vk==='V2'||vk==='V5'||vk==='V6'||vk==='V7'||vk==='V8'||vk==='V9'||vk==='V10'){gauge.variants[vk].recent=[...n30].sort((x,y)=>x[0]-y[0]).map(([E0,a])=>{a.sort((x,y)=>x.k-y.k);const s0=a.find(x=>x.k===0),fg=a.find(x=>gk(x)&&gk(x).color==='green');return {date:dkey(E0),c0:s0&&gk(s0)?gk(s0).color:null,L0:s0&&gk(s0)?+gk(s0).L.toFixed(0):null,stop0:s0?!!s0.stop:null,pnl0:s0?+s0.final.toFixed(1):null,firstGreen:fg?fg.k:null,stopG:fg?!!fg.stop:null,pnlG:fg?+fg.final.toFixed(1):null};});}
    gauge.variants[vk].series=null;if(crossBy[vk])gauge.variants[vk].patCross=crossBy[vk];
    if(vk==='V3')gauge._V3=gSeries;
  }
  /* exhaustion test: nights that were red/yellow-high earlier in the evening and then released to green by momentum exhaustion (V3) vs the same without momentum (V2) */
  {const mm=(nm,fn)=>{const a=O.filter(fn);console.log('  '+nm.padEnd(60)+' n '+String(a.length).padStart(4)+'  stopped '+String(st(a)).padStart(5)+'%  P&L '+String(pn(a)).padStart(6)+'%');return {name:nm,n:a.length,stop:st(a),pnl:pn(a)};};
  console.log('\nMOMENTUM EFFECT (V3 against V2 at the same entry hour)');
  gauge.momentum=[mm('momentum released the line to green (V3 green, V2 not)',s=>s.g_V3&&s.g_V2&&s.g_V3.color==='green'&&s.g_V2.color!=='green'),
    mm('momentum lifted the line to red (V3 red, V2 not)',s=>s.g_V3&&s.g_V2&&s.g_V3.color==='red'&&s.g_V2.color!=='red'),
    mm('V2 green and V3 green',s=>s.g_V3&&s.g_V2&&s.g_V3.color==='green'&&s.g_V2.color==='green'),
    mm('V2 red and V3 red',s=>s.g_V3&&s.g_V2&&s.g_V3.color==='red'&&s.g_V2.color==='red'),
    mm('V2 green but V3 not green (momentum held it back)',s=>s.g_V3&&s.g_V2&&s.g_V2.color==='green'&&s.g_V3.color!=='green')];}
  /* ---------- RELIABILITY of the shipped gauge (V10): calibration, stability by year, bootstrap confidence intervals ---------- */
  const reliability=(()=>{
    const K='g_V10',W=O.filter(s=>s[K]),pct=x=>+(x*100).toFixed(1);
    const L=s=>s[K].L,col=s=>s[K].color;
    // calibration: gauge level in 10-point bins -> how often a leg was stopped
    const bins=[];for(let lo=0;lo<100;lo+=10){const a=W.filter(s=>L(s)>=lo&&L(s)<lo+10+(lo===90?1:0));bins.push({lo,hi:lo+10,n:a.length,stop:a.length?pct(a.filter(s=>s.stop).length/a.length):null,pnl:a.length?+mean(a.map(s=>s.final)).toFixed(1):null});}
    // by year
    const years=[2023,2024,2025,2026].map(y=>{const a=W.filter(s=>s.yr===y),g=a.filter(s=>col(s)==='green'),r=a.filter(s=>col(s)==='red');return {year:y,n:a.length,auc:+auc(a.filter(s=>s.stop).map(L),a.filter(s=>!s.stop).map(L)).toFixed(3),green:{n:g.length,stop:g.length?pct(g.filter(s=>s.stop).length/g.length):null},red:{n:r.length,stop:r.length?pct(r.filter(s=>s.stop).length/r.length):null},base:pct(a.filter(s=>s.stop).length/a.length)};});
    // bootstrap over NIGHTS (5-minute-free: every night is resampled whole, so the hours of one night stay together)
    const byNight=new Map();for(const s of W){let a=byNight.get(s.E0);if(!a){a=[];byNight.set(s.E0,a);}a.push(s);}
    const keys=[...byNight.keys()];let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    const BN=500,m={auc:[],green:[],red:[],gap:[],firstGreenStop:[],firstGreenAvg:[],allAvg:[],notRedStop:[]};
    for(let b=0;b<BN;b++){const samp=[];const picked=[];for(let i=0;i<keys.length;i++){const k=keys[(rnd()*keys.length)|0];picked.push(k);for(const s of byNight.get(k))samp.push(s);}
      const pos=samp.filter(s=>s.stop).map(L),neg=samp.filter(s=>!s.stop).map(L);if(pos.length<20||neg.length<20)continue;m.auc.push(auc(pos,neg));
      const g=samp.filter(s=>col(s)==='green'),r=samp.filter(s=>col(s)==='red');if(g.length<20||r.length<20)continue;const gs=g.filter(s=>s.stop).length/g.length*100,rs=r.filter(s=>s.stop).length/r.length*100;m.green.push(gs);m.red.push(rs);m.gap.push(rs-gs);
      const fg=[],nr=[],al=[];for(const k of picked){const a=byNight.get(k).slice().sort((x,y)=>x.k-y.k);const f=a.find(x=>col(x)==='green');if(f)fg.push(f);const z=a.find(x=>x.k===0);if(z){al.push(z);if(col(z)!=='red')nr.push(z);}}
      if(fg.length>10){m.firstGreenStop.push(fg.filter(s=>s.stop).length/fg.length*100);m.firstGreenAvg.push(mean(fg.map(s=>s.final)));}m.allAvg.push(mean(al.map(s=>s.final)));if(nr.length>10)m.notRedStop.push(nr.filter(s=>s.stop).length/nr.length*100);}
    const ci=a=>{a.sort((x,y)=>x-y);return [+quant(a,2.5).toFixed(3),+quant(a,50).toFixed(3),+quant(a,97.5).toFixed(3)];};
    const boot={auc:ci(m.auc),green:ci(m.green),red:ci(m.red),gap:ci(m.gap),firstGreenStop:ci(m.firstGreenStop),firstGreenAvg:ci(m.firstGreenAvg),allAvg:ci(m.allAvg),notRedStop:ci(m.notRedStop),pGreenBeatsRed:+(m.gap.filter(x=>x>0).length/m.gap.length).toFixed(3),pAucAbove55:+(m.auc.filter(x=>x>0.55).length/m.auc.length).toFixed(3),boots:m.gap.length};
    // the last 90 and 30 nights, same rules
    const lastE=Math.max(...keys),win=(d)=>{const a=W.filter(s=>s.E0>lastE-d*DAY),g=a.filter(s=>col(s)==='green'),r=a.filter(s=>col(s)==='red'),y=a.filter(s=>col(s)==='yellow'),f=x=>x.length?pct(x.filter(s=>s.stop).length/x.length):null;return {days:d,n:a.length,green:{n:g.length,stop:f(g)},yellow:{n:y.length,stop:f(y)},red:{n:r.length,stop:f(r)},base:f(a)};};
    const r90=win(90),r30=win(30),r180=win(180);
    console.log('RELIABILITY of the shipped gauge (V10), out-of-sample 2023-26');
    for(const b of bins)console.log('  level '+String(b.lo).padStart(2)+'-'+String(b.hi).padEnd(3)+' n '+String(b.n).padStart(4)+'  stopped '+String(b.stop).padStart(5)+'%  avg P&L '+String(b.pnl).padStart(5)+'%');
    for(const y of years)console.log('  '+y.year+'  AUC '+y.auc+'  green '+y.green.stop+'% (n'+y.green.n+')  red '+y.red.stop+'% (n'+y.red.n+')  all '+y.base+'%');
    console.log('  bootstrap ('+boot.boots+' resamples of whole nights): AUC '+boot.auc.join(' / ')+'  green stopped '+boot.green.join(' / ')+'  red stopped '+boot.red.join(' / ')+'  red-minus-green '+boot.gap.join(' / '));
    console.log('  P(green is calmer than red) '+boot.pGreenBeatsRed+'   P(AUC > 0.55) '+boot.pAucAbove55+'   first-green stopped '+boot.firstGreenStop.join(' / ')+'  avg P&L first-green '+boot.firstGreenAvg.join(' / ')+' vs sell-every-night '+boot.allAvg.join(' / ')+'  not-red stopped '+boot.notRedStop.join(' / '));
    console.log('  last 180/90/30 days: '+[r180,r90,r30].map(w=>w.days+'d green '+w.green.stop+'%(n'+w.green.n+') yellow '+w.yellow.stop+'%(n'+w.yellow.n+') red '+w.red.stop+'%(n'+w.red.n+') all '+w.base+'%').join(' | '));
    return {bins,years,boot,recent:[r180,r90,r30]};
  })();
  /* ---------- SELF-LEARNING test: can a small online learner improve the gauge as live outcomes arrive? (prequential: every prediction is made BEFORE its outcome is seen) ---------- */
  const learner=(()=>{
    const FN=['spd','model','fear','rise','vov','rv','edge','adx','bear','burst'];
    const cl01=x=>Math.max(0,Math.min(1,x));
    const feat=(s)=>{const F=FMforYear(s.yr<2023?2023:s.yr);const b=gaugeBase(s.E,F,s.yr<2023?2023:s.yr);if(!b)return null;return [...['spd','model','fear','rise','vov','rv','edge','adx'].map(k=>b.soft[k]),b.bear?1:0,b.rr==null?0:cl01((b.rr-1.5)/1.5)];};
    const all=samples.slice().sort((a,b)=>a.E-b.E);for(const s of all)s.lx=feat(s);const ok=all.filter(s=>s.lx);
    const sig=z=>1/(1+Math.exp(-z)),dot=(w,x)=>{let z=w[0];for(let i=0;i<x.length;i++)z+=w[i+1]*x[i];return z;};
    const train=ok.filter(s=>s.yr<2023),test=ok.filter(s=>s.yr>=2023);
    const w0=fitLogit(train.map(s=>s.lx),train.map(s=>s.stop?1:0),3);
    const ll=(p,y)=>-(y?Math.log(Math.max(1e-6,p)):Math.log(Math.max(1e-6,1-p)));
    const run=(lr,lam)=>{const w=w0.slice();const P=[],Y=[],Pf=[],yrs=[];let lls=0,llf=0,n=0;const cum=[];
      const nightsL=[];{let cur=null;for(const s of test){if(!cur||cur.E0!==s.E0){cur={E0:s.E0,a:[]};nightsL.push(cur);}cur.a.push(s);}}
      for(const nt of nightsL){const pend=[];   // all of a night's entry hours are predicted first; the night's outcome only arrives next morning, then the learner updates
        for(const s of nt.a){const z=dot(w,s.lx),p=sig(z),pf=sig(dot(w0,s.lx)),y=s.stop?1:0;P.push(p);Pf.push(pf);Y.push(y);yrs.push(s.yr);lls+=ll(p,y);llf+=ll(pf,y);n++;pend.push([s,p,y]);if(n%200===0)cum.push({n,online:+(lls/n).toFixed(4),frozen:+(llf/n).toFixed(4)});}
        for(const [s,p,y] of pend){const g=y-p;w[0]+=lr*g;for(let i=0;i<s.lx.length;i++)w[i+1]+=lr*(g*s.lx[i]-lam*(w[i+1]-w0[i+1]));}}
      const a=(pp)=>auc(pp.filter((_,i)=>Y[i]).map(x=>x),pp.filter((_,i)=>!Y[i]).map(x=>x));
      return {lr,lam,logloss:+(lls/n).toFixed(4),frozenLogloss:+(llf/n).toFixed(4),auc:+a(P).toFixed(3),frozenAuc:+a(Pf).toFixed(3),n,cum,weights:w.map(x=>+x.toFixed(3))};};
    console.log('SELF-LEARNING (prequential, 2023-26): a logistic learner starts from the weights fitted on 2021-22 and updates after every outcome');
    const res=[];for(const lr of [0.005,0.01,0.02,0.05,0.1])for(const lam of [0,0.5]){const r=run(lr,lam);res.push(r);console.log('  lr '+lr+' lam '+lam+'  logloss online '+r.logloss+' vs frozen '+r.frozenLogloss+'   AUC online '+r.auc+' vs frozen '+r.frozenAuc);}
    const best=res.slice().sort((a,b)=>a.logloss-b.logloss)[0];console.log('  best: lr '+best.lr+' lam '+best.lam+'  learning curve (logloss after n samples): '+best.cum.filter((_,i)=>i%4===0).map(c=>c.n+': '+c.online+'/'+c.frozen).join('  '));
    console.log('  prior weights (bias, '+FN.join(', ')+'): '+w0.map(x=>x.toFixed(2)).join(' '));
    // a base-rate-only learner (does the gauge add anything beyond "the stop rate has been X lately")?
    let base=0,nb=0,llb=0;for(const s of test){const p=nb?base/nb:0.23;llb+=ll(Math.min(0.95,Math.max(0.05,p)),s.stop?1:0);base+=s.stop?1:0;nb++;}
    console.log('  for reference, logloss of "just the running stop rate": '+(llb/nb).toFixed(4));
    return {features:FN,w0:w0.map(x=>+x.toFixed(4)),runs:res.map(r=>({lr:r.lr,lam:r.lam,logloss:r.logloss,frozen:r.frozenLogloss,auc:r.auc,frozenAuc:r.frozenAuc})),best:{lr:best.lr,lam:best.lam,logloss:best.logloss,frozen:best.frozenLogloss,auc:best.auc,frozenAuc:best.frozenAuc,cum:best.cum},baseLogloss:+(llb/nb).toFixed(4),trainN:train.length,testN:test.length};
  })();
  /* ---------- BIG MOVES after entry: did BTC go 0.9 % (or 800 points) to one side within the 8-hour hold, by gauge colour (V10), all 5 years ---------- */
  const moves=(()=>{
    const V=VARIANTS.V10,by=new Map();for(const s of samples){let a=by.get(s.E0);if(!a){a=[];by.set(s.E0,a);}a.push(s);}
    const rows=[];
    for(const [E0,a] of by){const yr=a[0].yr,F=FMforYear(yr<2023?2023:yr),S=gaugeSeries(E0,F,yr,V);if(!S.length)continue;
      for(const s of a){const p=S.find(q=>q.E===s.E);if(!p)continue;const b0=byT.get(s.E);if(!b0)continue;const S0=b0.c;let hu=0,hd=0,hu3=0,hd3=0,ok=0;const mu=[0],md=[0];
        for(let h=1;h<=8;h++){const b=byT.get(s.E+h*HOUR);if(!b){mu.push(hu);md.push(hd);continue;}ok++;const u=b.h-S0,d=S0-b.l;if(u>hu)hu=u;if(d>hd)hd=d;if(h<=3){if(u>hu3)hu3=u;if(d>hd3)hd3=d;}mu.push(hu);md.push(hd);}
        if(ok<6)continue;rows.push({E:s.E,E0,yr:s.yr,k:s.k,color:p.color,L:p.L,sc:p.sc,rising:p.rising,S0,up:hu,dn:hd,up3:hu3,dn3:hd3,mu,md,stop:s.stop,oos:s.yr>=2023,wd:s.wd,s});}}
    const P=0.009,f1=r=>r.up>=P*r.S0||r.dn>=P*r.S0,fPts=r=>r.up>=800||r.dn>=800;
    const stat=a=>{const n=a.length;if(!n)return {n:0};const pc=x=>+(a.filter(x).length/n*100).toFixed(1);return {n,either:pc(f1),up:pc(r=>r.up>=P*r.S0),down:pc(r=>r.dn>=P*r.S0),both:pc(r=>r.up>=P*r.S0&&r.dn>=P*r.S0),pts800:pc(fPts),first3h:pc(r=>r.up3>=P*r.S0||r.dn3>=P*r.S0),avgMax:+(mean(a.map(r=>Math.max(r.up,r.dn)/r.S0*100))).toFixed(2),stop:pc(r=>r.stop)};};
    const byColor=(a)=>Object.fromEntries(['red','yellow','green'].map(c=>[c,stat(a.filter(r=>r.color===c))]));
    const all=byColor(rows),oos=byColor(rows.filter(r=>r.oos));
    const years=[2021,2022,2023,2024,2025,2026].map(y=>({year:y,oos:y>=2023,...byColor(rows.filter(r=>r.yr===y)),all:stat(rows.filter(r=>r.yr===y))}));
    const lastE0=Math.max(...rows.map(r=>r.E0)),rec=d=>({days:d,...byColor(rows.filter(r=>r.E0>lastE0-d*DAY))});
    const aucMove=(a,lab)=>+auc(a.filter(lab).map(r=>r.L),a.filter(r=>!lab(r)).map(r=>r.L)).toFixed(3);
    const O=rows.filter(r=>r.oos);
    // bootstrap over nights: green minus red rate of 0.9 % moves
    const byN=new Map();for(const r of O){let a=byN.get(r.E0);if(!a){a=[];byN.set(r.E0,a);}a.push(r);}const ks=[...byN.keys()];let sd0=777;const rnd=()=>{sd0=(sd0*1664525+1013904223)>>>0;return sd0/4294967296;};const gaps=[],gr=[],rd=[];
    for(let b=0;b<400;b++){const smp=[];for(let i=0;i<ks.length;i++)for(const r of byN.get(ks[(rnd()*ks.length)|0]))smp.push(r);const g=smp.filter(r=>r.color==='green'),d=smp.filter(r=>r.color==='red');if(g.length<20||d.length<20)continue;const a=g.filter(f1).length/g.length*100,c=d.filter(f1).length/d.length*100;gr.push(a);rd.push(c);gaps.push(c-a);}
    const ci=a=>{a.sort((x,y)=>x-y);return [+quant(a,2.5).toFixed(1),+quant(a,50).toFixed(1),+quant(a,97.5).toFixed(1)];};
    const out={threshold:'0.9 % of the entry price (about 730-800 points) or 800 points, either side, within the 8-hour hold',n:rows.length,nOos:O.length,all,oos,years,recent:[rec(90),rec(30)],auc:{move:aucMove(O,f1),pts800:aucMove(O,fPts),stop:aucMove(O,r=>r.stop)},boot:{green:ci(gr),red:ci(rd),gap:ci(gaps),pGreenCalmer:+(gaps.filter(x=>x>0).length/gaps.length).toFixed(3)},baseOos:stat(O),baseAll:stat(rows)};
    const line=(nm,o)=>console.log('  '+nm.padEnd(8)+' n '+String(o.n).padStart(5)+'  0.9% move either side '+String(o.either).padStart(5)+'%  up '+String(o.up).padStart(5)+'%  down '+String(o.down).padStart(5)+'%  both '+String(o.both).padStart(4)+'%  800pts '+String(o.pts800).padStart(5)+'%  first 3h '+String(o.first3h).padStart(5)+'%  avg biggest '+o.avgMax+'%  stopped '+o.stop+'%');
    console.log('BIG MOVES AFTER ENTRY (gauge V10; '+out.n+' entry hours 2021-26, '+out.nOos+' out-of-sample 2023-26; 2021-22 colours use the 2023 model, so they are in-sample)');
    console.log(' all five years:');for(const c of ['red','yellow','green'])line(c,all[c]);line('ALL',out.baseAll);
    console.log(' out-of-sample 2023-26:');for(const c of ['red','yellow','green'])line(c,oos[c]);line('ALL',out.baseOos);
    for(const y of years){console.log(' '+y.year+(y.oos?'':' (in-sample)')+':  red '+y.red.either+'% (n'+y.red.n+')  yellow '+y.yellow.either+'% (n'+y.yellow.n+')  green '+y.green.either+'% (n'+y.green.n+')  all '+y.all.either+'%');}
    for(const r of out.recent)console.log(' last '+r.days+' days:  red '+r.red.either+'% (n'+r.red.n+')  yellow '+r.yellow.either+'% (n'+r.yellow.n+')  green '+r.green.either+'% (n'+r.green.n+')');
    console.log(' bootstrap (400, whole nights, out-of-sample): green '+out.boot.green.join(' / ')+'%  red '+out.boot.red.join(' / ')+'%  red minus green '+out.boot.gap.join(' / ')+'  P(green calmer) '+out.boot.pGreenCalmer);
    console.log(' AUC of the gauge level: for a 0.9% move '+out.auc.move+', for 800 points '+out.auc.pts800+', for a stopped leg '+out.auc.stop);
    const GRID=[[1,0.009],[3,0.009],[8,0.009],[3,0.015],[8,0.015],[8,0.025]];const lab=(h,pc)=>r=>r.mu[h]>=pc*r.S0||r.md[h]>=pc*r.S0;
    out.grid=GRID.map(([h,pc])=>{const f=lab(h,pc);const c=x=>+(x.filter(f).length/x.length*100).toFixed(1);return {hours:h,pct:pc*100,all:c(O),red:c(O.filter(r=>r.color==='red')),yellow:c(O.filter(r=>r.color==='yellow')),green:c(O.filter(r=>r.color==='green')),auc:aucMove(O,f)};});
    console.log(' how often (out-of-sample) BTC moved a given % to ONE side within a window after entry, by colour:');
    for(const g of out.grid)console.log('   within '+g.hours+'h, '+g.pct+'%:  all '+g.all+'%   red '+g.red+'%   yellow '+g.yellow+'%   green '+g.green+'%   AUC of the level '+g.auc);
    out._rows=rows;return out;
  })();
  const refit=(()=>{ // which checks matter for BIG MOVES? ridge logistic on the soft check values, fitted on 2021-22, scored on 2023-26
    const rows=moves._rows.filter(r=>r.s.lx),tr=rows.filter(r=>!r.oos),te=rows.filter(r=>r.oos);const FN=['spd','model','fear','rise','vov','rv','edge','adx','bear','burst'];const out={};
    const defs={m1:(r)=>r.mu[1]>=0.009*r.S0||r.md[1]>=0.009*r.S0,m3:(r)=>r.mu[3]>=0.009*r.S0||r.md[3]>=0.009*r.S0,m8:(r)=>r.mu[8]>=0.015*r.S0||r.md[8]>=0.015*r.S0,stop:(r)=>r.stop};
    console.log(' REFIT: weight of each check for each label (ridge logistic, fitted 2021-22), AUC on 2023-26 against the current gauge level');
    console.log('   features: '+FN.join(' '));
    for(const [k,f] of Object.entries(defs)){const w=fitLogit(tr.map(r=>r.s.lx),tr.map(r=>f(r)?1:0),3);const sc=r=>{let z=w[0];for(let i=0;i<r.s.lx.length;i++)z+=w[i+1]*r.s.lx[i];return z;};
      const a1=auc(te.filter(f).map(sc),te.filter(r=>!f(r)).map(sc)),a2=auc(te.filter(f).map(r=>r.L),te.filter(r=>!f(r)).map(r=>r.L));out[k]={w:w.map(x=>+x.toFixed(2)),aucFit:+a1.toFixed(3),aucGauge:+a2.toFixed(3)};
      console.log('   '+k.padEnd(5)+' weights '+w.slice(1).map(x=>x.toFixed(2)).join(' ')+'  | AUC refit '+a1.toFixed(3)+' vs current gauge '+a2.toFixed(3));}
    console.log('   current hand weights (scaled to 1): '+['spd','model','fear','rise','vov','rv','edge','adx'].map(k=>(GW[k]/GWT).toFixed(2)).join(' '));
    return out;})();
  {const O=moves._rows.filter(r=>r.oos),f1=r=>r.mu[1]>=0.009*r.S0||r.md[1]>=0.009*r.S0,f3=r=>r.mu[3]>=0.009*r.S0||r.md[3]>=0.009*r.S0,f8=r=>r.mu[8]>=0.015*r.S0||r.md[8]>=0.015*r.S0;
   const pc=(a,f)=>a.length?(a.filter(f).length/a.length*100).toFixed(1):'-';const strict=[];moves.strict=strict;const row=(nm,a)=>{strict.push({name:nm,n:a.length,m1:+pc(a,f1),m3:+pc(a,f3),m8:+pc(a,f8),stop:+pc(a,r=>r.stop)});console.log('  '+nm.padEnd(46)+' n '+String(a.length).padStart(4)+'  0.9% in 1h '+String(pc(a,f1)).padStart(5)+'%  in 3h '+String(pc(a,f3)).padStart(5)+'%  1.5% in 8h '+String(pc(a,f8)).padStart(5)+'%  stopped '+String(pc(a,r=>r.stop)).padStart(5)+'%');};
   console.log(' STRICTER GREEN? green hours split by the risk-model score at entry (0 = calmest)');
   const G=O.filter(r=>r.color==='green');row('green, all',G);for(const t of [4,8,12,16,20])row('green and model score <= '+t,G.filter(r=>r.sc<=t));row('green and model score > 12',G.filter(r=>r.sc>12));
   row('yellow, all',O.filter(r=>r.color==='yellow'));row('yellow and model score <= 8',O.filter(r=>r.color==='yellow'&&r.sc<=8));row('red, all',O.filter(r=>r.color==='red'));row('red and rising only',O.filter(r=>r.color==='red'&&r.rising));row('red and not rising',O.filter(r=>r.color==='red'&&!r.rising));}
  moves.refit=refit;gauge.moves=(({_rows,...r})=>r)(moves);
  gauge.learner=learner;
  gauge.reliability=reliability;
  gauge.weights=GW;gauge.note='red >= 66; green = L < 34 and the main checks pass; yellow otherwise. Rises at once (faster when momentum builds), falls after two better hours (at once when momentum is spent).';
  delete gauge._V3;

  /* ---------- write the model for the desk ---------- */
  const names=Object.fromEntries([...ORDER.map(([k,l])=>[k,l]),['r6','6h move'],['r24','24h move'],['rng6','6h range'],['rvr','RV 6h ÷ 24h'],['dchg','IV change 24h'],['spk','NY IV spike']]);
  /* parity check: the same model on the newest hours (compare with the desk's lane) */
  if(process.env.CHECK){const lastH=Math.floor(prices[prices.length-1][0]/HOUR)*HOUR;for(let h=7;h>=0;h--){const E=lastH-h*HOUR,f=featuresAt(E);if(!f){console.log(new Date(E).toISOString(),'no features');continue;}const z=FM.score(f);console.log(new Date(E).toISOString().slice(0,16),'score',toScore(z).toFixed(1),JSON.stringify(Object.fromEntries(Object.entries(f).map(([k,v])=>[k,v==null?null:+v.toFixed(3)]))));}}
  const out={generated:dkey(Date.now()),samples:samples.length,baseStopPct:+base.toFixed(1),span:[dkey(samples[0].E),dkey(samples[samples.length-1].E)],feats:FEATS,names,
    coef:{b:+FM.w[0].toFixed(5),w:Object.fromEntries(FEATS.map((k,i)=>[k,+FM.w[i+1].toFixed(4)]))},pct:FM.pct,calibration:cal,
    wfAuc:{old:+mean(aucOld).toFixed(3),logistic:+mean(aucNew).toFixed(3),sets:setAuc},oosBands:bandRows,oosAbove25:{n:above.length,stop:st(above),pnl:pn(above)},oosAtOrBelow25:{n:below.length,stop:st(below),pnl:pn(below)},
    dynamics:dyn,strategies:res,exit:exitRows,regimes:regimeRows,journey,gauge,sessions,patterns:patternRows};
  const js=`window.__STRANGLE_RISKMODEL = ${JSON.stringify(out)};\n`;
  if(!process.env.NOWRITE)for(const rel of ['../../data/risk_model.js','../../frontend/public/data/risk_model.js'])fs.writeFileSync(P(rel),js);
  console.log('\nlogistic weights (on centred percentile rank; + = riskier):',JSON.stringify(out.coef.w),'calibration',JSON.stringify(cal));
}
main();
