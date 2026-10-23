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

const FIXEDW={spd:10,atm:8,spk:7,rng:6,vov:5,dchg:4,rv:3,edge:3,clk:2.5,dvol:2,adx:1.5,rsi:1,rng6:1,r6:0.5,r24:0.5,rvr:0.5};   // FIXED=1: the user's priority order, speed > ATM IV > range > VoV
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

  /* ---------- write the model for the desk ---------- */
  const names=Object.fromEntries([...ORDER.map(([k,l])=>[k,l]),['r6','6h move'],['r24','24h move'],['rng6','6h range'],['rvr','RV 6h ÷ 24h'],['dchg','IV change 24h'],['spk','NY IV spike']]);
  /* parity check: the same model on the newest hours (compare with the desk's lane) */
  if(process.env.CHECK){const lastH=Math.floor(prices[prices.length-1][0]/HOUR)*HOUR;for(let h=7;h>=0;h--){const E=lastH-h*HOUR,f=featuresAt(E);if(!f){console.log(new Date(E).toISOString(),'no features');continue;}const z=FM.score(f);console.log(new Date(E).toISOString().slice(0,16),'score',toScore(z).toFixed(1),JSON.stringify(Object.fromEntries(Object.entries(f).map(([k,v])=>[k,v==null?null:+v.toFixed(3)]))));}}
  const out={generated:dkey(Date.now()),samples:samples.length,baseStopPct:+base.toFixed(1),span:[dkey(samples[0].E),dkey(samples[samples.length-1].E)],feats:FEATS,names,
    coef:{b:+FM.w[0].toFixed(5),w:Object.fromEntries(FEATS.map((k,i)=>[k,+FM.w[i+1].toFixed(4)]))},pct:FM.pct,calibration:cal,
    wfAuc:{old:+mean(aucOld).toFixed(3),logistic:+mean(aucNew).toFixed(3),sets:setAuc},oosBands:bandRows,oosAbove25:{n:above.length,stop:st(above),pnl:pn(above)},oosAtOrBelow25:{n:below.length,stop:st(below),pnl:pn(below)},
    dynamics:dyn,strategies:res,exit:exitRows,regimes:regimeRows,journey};
  const js=`window.__STRANGLE_RISKMODEL = ${JSON.stringify(out)};\n`;
  for(const rel of ['../../data/risk_model.js','../../frontend/public/data/risk_model.js'])fs.writeFileSync(P(rel),js);
  console.log('\nlogistic weights (on centred percentile rank; + = riskier):',JSON.stringify(out.coef.w),'calibration',JSON.stringify(cal));
}
main();
