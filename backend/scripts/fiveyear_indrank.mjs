/**
 * FIVE-YEAR INDICATOR RANKING — which of the desk's indicators best flags a stopped-out night, ranked per
 * weekday / week-of-month / month, plus the weights + calibration behind the composite "Risk-ADX" lane.
 *
 * Per weekday night (entry 22:30 IST = 17:00 UTC) we read every indicator that has 5-year history, simulate the
 * overnight 0.15Δ strangle (DVOL as IV, Black-Scholes legs, stop@2× within 8 h, same as fiveyear_adx.mjs), and
 * ask: when the indicator is in its riskiest 30 %, how much higher is the stop rate than the rest of the nights
 * ("lift", in percentage points)? Direction of "risky" is learned from the data (sign of the stop/no-stop gap).
 *
 * Honest caveats: DVOL (30-day IV) is the IV proxy for every night; option legs are modelled, not real prices;
 * skew, term spread, bid/ask, IV-crush, greeks, funding/OI, futures positioning and macro stress have no 5-year
 * history and are NOT scored here (they stay in the composite with a priority-order weight, flagged live-only).
 * Run: node scripts/fiveyear_indrank.mjs   → data/indicator_rank_dynamic.js + frontend/public/data/ copy
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

// the user's priority order (1 = most important). key → [priority, label]
const ORDER=[['spd','IV vs speed'],['atm','ATM IV'],['vov','VoV'],['rv','RV'],['rng','Range 24'],['edge','Edge'],['clk','Tonight IV vs clock'],['dvol','DVOL'],['skew','25Δ skew'],['adx','ADX'],['rsi','RSI'],['macro','Macro stress'],['fut','Futures positioning'],['fund','Funding / OI'],['term','Term spread'],['bidask','Bid/ask spread'],['crush','IV crush driver'],['greeks','ATM greeks']];
const PRIO=Object.fromEntries(ORDER.map(([k],i)=>[k,i+1]));
const BACKTESTED=['spd','atm','vov','rv','rng','edge','clk','dvol','adx','rsi'];
const VETO_PCT=70, MIN_N=15;

function adxSeries(bars,per=14){
  const out=new Map(); if(bars.length<per*2)return out;
  const sm={tr:0,p:0,n:0}; let adx=0,dxCount=0,dxSum=0;
  for(let i=1;i<bars.length;i++){
    const h=bars[i].h,l=bars[i].l,pc=bars[i-1].c,ph=bars[i-1].h,pl=bars[i-1].l;
    const trv=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
    const up=h-ph,dn=pl-l; const pdmv=(up>dn&&up>0)?up:0, ndmv=(dn>up&&dn>0)?dn:0;
    if(i<=per){sm.tr+=trv;sm.p+=pdmv;sm.n+=ndmv;continue;}
    sm.tr=sm.tr-sm.tr/per+trv; sm.p=sm.p-sm.p/per+pdmv; sm.n=sm.n-sm.n/per+ndmv;
    const pdi=100*sm.p/sm.tr, ndi=100*sm.n/sm.tr; const dx=100*Math.abs(pdi-ndi)/((pdi+ndi)||1);
    dxCount++;
    if(dxCount<per){dxSum+=dx; if(dxCount===per-1)adx=dxSum/per;}
    else{adx=(adx*(per-1)+dx)/per; out.set(bars[i].t,adx);}
  }
  return out;
}
function rsiSeries(bars,per=14){
  const out=new Map(); let g=0,l=0;
  for(let i=1;i<bars.length;i++){
    const d=bars[i].c-bars[i-1].c,u=Math.max(d,0),dn=Math.max(-d,0);
    if(i<=per){g+=u/per;l+=dn/per;if(i<per)continue;}else{g=(g*(per-1)+u)/per;l=(l*(per-1)+dn)/per;}
    out.set(bars[i].t,l===0?100:100-100/(1+g/l));
  }
  return out;
}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const sd=a=>{const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,a.length-1));};
const pctOf=(sorted,v)=>{let lo=0,hi=sorted.length;while(lo<hi){const m=(lo+hi)>>1;if(sorted[m]<v)lo=m+1;else hi=m;}return 100*lo/sorted.length;};
const quant=(sorted,q)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.round(q/100*(sorted.length-1))))];

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-full.json'),'utf8')); // [t,h,l,c]
  const b1=prices.map(b=>({t:b[0],h:b[1],l:b[2],c:b[3]})); const byT=new Map(b1.map(b=>[b.t,b]));
  const adx=adxSeries(b1), rsi=rsiSeries(b1);
  const dd=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8')); const dv=new Map(dd.map(([t,v])=>[dkey(t),v]));
  const dh=new Map(JSON.parse(fs.readFileSync(P('./btc-dvol-5y-1h.json'),'utf8')));
  const T0=3/365, first=prices[0][0], last=prices[prices.length-1][0];
  const nights=[];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR, wd=new Date(E).getUTCDay(); if(wd<1||wd>5)continue;
    const entry=byT.get(E), ivD=dv.get(dkey(E)); if(!entry||ivD==null||!(entry.c>0))continue;
    // --- outcome: stop@2× within the next 8 h (same rule as fiveyear_adx.mjs)
    const S0=entry.c, iv=ivD/100, Kc=strikeK(S0,T0,iv,0.15,'c'), Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'), p0=bs(S0,Kp,T0,iv,'p'); if(!(c0>0)||!(p0>0))continue;
    let stop=false,have=0; for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b.h,Kc,T,iv,'c')>=2*c0||bs(b.l,Kp,T,iv,'p')>=2*p0)stop=true;}
    if(have<6)continue;
    // --- features at entry
    const w24=[];for(let h=24;h>=1;h--){const a=byT.get(E-h*HOUR),b=byT.get(E-(h-1)*HOUR);if(a&&b)w24.push([a,b]);}
    if(w24.length<18)continue;
    const lr=w24.map(([a,b])=>Math.log(b.c/a.c)), rv24=sd(lr)*ANN*100;
    const r6=lr.slice(-6), rv6=r6.length>=5?sd(r6)*ANN*100:null;
    const hi24=Math.max(...w24.map(([,b])=>b.h)), lo24=Math.min(...w24.map(([,b])=>b.l));
    const ivH=dh.get(E)??ivD;
    const dser=[];for(let h=24;h>=0;h--){const v=dh.get(E-h*HOUR);if(v>0)dser.push(v);}
    let vov=null; if(dser.length>=12){const ch=[];for(let i=1;i<dser.length;i++)ch.push(Math.log(dser[i]/dser[i-1]));vov=sd(ch)*100;}
    const d6=[];for(let h=6;h>=0;h--){const v=dh.get(E-h*HOUR);if(v>0)d6.push(v);}
    const x=adx.get(E), r=rsi.get(E); if(x==null||r==null)continue;
    const f={
      spd:rv24/ivD, atm:ivH, vov, rv:rv6, rng:((hi24-lo24)/S0*100)/(ivD/Math.sqrt(365)), edge:ivD-rv24,
      clk:d6.length>=4?ivH/Math.max(...d6):null, dvol:ivD, adx:x, rsi:r
    };
    const dt=new Date(E);
    nights.push({E,stop,wd,wom:Math.ceil(dt.getUTCDate()/7),mo:dt.getUTCMonth()+1,f});
  }
  const N=nights.length, base=nights.filter(n=>n.stop).length/N*100;

  // --- orientation (which side is risky) + percentile tables, learned on all nights
  const meta={};
  for(const k of BACKTESTED){
    const v=nights.filter(n=>n.f[k]!=null); const sorted=v.map(n=>n.f[k]).sort((a,b)=>a-b);
    const mS=mean(v.filter(n=>n.stop).map(n=>n.f[k])), mN=mean(v.filter(n=>!n.stop).map(n=>n.f[k]));
    const o=mS>=mN?1:-1;   // +1: high value = risk, −1: low value = risk
    meta[k]={o,n:v.length,sorted,pct:Array.from({length:21},(_,i)=>+quant(sorted,i*5).toFixed(4))};
  }
  for(const n of nights){n.risk={};for(const k of BACKTESTED){const v=n.f[k];if(v==null)continue;const p=pctOf(meta[k].sorted,v);n.risk[k]=meta[k].o>0?p:100-p;}}

  // --- lift of an indicator over a set of nights
  const liftOf=(set,k)=>{
    const v=set.filter(n=>n.risk[k]!=null), hot=v.filter(n=>n.risk[k]>=VETO_PCT), cool=v.filter(n=>n.risk[k]<VETO_PCT);
    if(hot.length<MIN_N||cool.length<MIN_N)return null;
    const sh=hot.filter(n=>n.stop).length/hot.length*100, sc=cool.filter(n=>n.stop).length/cool.length*100;
    // shrink small samples toward 0 so a lucky 20-night bucket cannot top the ranking
    const lift=(sh-sc)*hot.length/(hot.length+40);
    return {k,lift:+lift.toFixed(1),hot:+sh.toFixed(1),rest:+sc.toFixed(1),n:hot.length};
  };
  const rankSet=(set)=>BACKTESTED.map(k=>liftOf(set,k)).filter(Boolean).sort((a,b)=>b.lift-a.lift||PRIO[a.k]-PRIO[b.k]);
  const groups=(key,vals)=>Object.fromEntries(vals.map(g=>[g,rankSet(nights.filter(n=>n[key]===g))]));
  const overall=rankSet(nights);

  // --- composite weights: backtested lift (floored) + a small bonus for the user's priority; live-only indicators
  //     get the median backtested weight scaled by priority
  const raw={}; for(const k of BACKTESTED){const o=overall.find(x=>x.k===k);raw[k]=Math.max(0.5,o?o.lift:0)+(19-PRIO[k])/18*0.5;}
  const med=[...Object.values(raw)].sort((a,b)=>a-b)[Math.floor(BACKTESTED.length/2)];
  for(const [k] of ORDER)if(!BACKTESTED.includes(k))raw[k]=med*(0.35+0.4*(19-PRIO[k])/18);
  const tot=Object.values(raw).reduce((a,b)=>a+b,0), weights=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,+(v/tot).toFixed(4)]));

  // --- composite on the backtested indicators only (the live-only ones are absent from history), re-normalised
  const wB=BACKTESTED.reduce((a,k)=>a+weights[k],0);
  for(const n of nights){let s=0,w=0;for(const k of BACKTESTED){if(n.risk[k]==null)continue;s+=n.risk[k]*weights[k];w+=weights[k];}n.raw=w>0?s/w:null;}
  const rawSorted=nights.map(n=>n.raw).filter(x=>x!=null).sort((a,b)=>a-b);
  const cal={p5:+quant(rawSorted,5).toFixed(2),p70:+quant(rawSorted,70).toFixed(2),p100:+quant(rawSorted,100).toFixed(2)};
  const score=r=>r<=cal.p70?25*Math.max(0,(r-cal.p5))/(cal.p70-cal.p5):25+75*(r-cal.p70)/(cal.p100-cal.p70);
  for(const n of nights)n.score=n.raw==null?null:score(n.raw);
  const hotN=nights.filter(n=>n.score>25), calmN=nights.filter(n=>n.score!=null&&n.score<=25);
  const sr=a=>a.length?+(a.filter(n=>n.stop).length/a.length*100).toFixed(1):null;
  const composite={above25:{n:hotN.length,stop:sr(hotN)},atOrBelow25:{n:calmN.length,stop:sr(calmN)},byWeekday:{}};
  for(const w of [1,2,3,4,5]){const a=hotN.filter(n=>n.wd===w),b=calmN.filter(n=>n.wd===w);composite.byWeekday[w]={above25:{n:a.length,stop:sr(a)},atOrBelow25:{n:b.length,stop:sr(b)}};}

  // stability: the same cut-off year by year (orientation / percentiles were learned on all years, so this is a
  // consistency check, not a true out-of-sample test)
  composite.byYear={}; for(const y of [...new Set(nights.map(n=>new Date(n.E).getUTCFullYear()))]){const a=hotN.filter(n=>new Date(n.E).getUTCFullYear()===y),b=calmN.filter(n=>new Date(n.E).getUTCFullYear()===y);composite.byYear[y]={above25:{n:a.length,stop:sr(a)},atOrBelow25:{n:b.length,stop:sr(b)}};}

  // the gate's own rules, tested on the same nights: stop% when the rule fires (would WAIT) vs when it does not
  const ruleTest=(name,fn)=>{const a=nights.filter(n=>fn(n)===true),b=nights.filter(n=>fn(n)===false);return {name,fires:{n:a.length,stop:sr(a)},clear:{n:b.length,stop:sr(b)}};};
  const dvolOf=n=>n.f.dvol, spdOf=n=>n.f.spd;
  const rules=[
    ruleTest('Thursday',n=>n.wd===4), ruleTest('Friday',n=>n.wd===5), ruleTest('Monday',n=>n.wd===1),
    ruleTest('Speed ≥ 1.5×',n=>spdOf(n)==null?null:spdOf(n)>=1.5), ruleTest('Speed ≥ 1.2×',n=>spdOf(n)==null?null:spdOf(n)>=1.2),
    ruleTest('DVOL ≥ 65',n=>dvolOf(n)>=65), ruleTest('DVOL ≥ 55',n=>dvolOf(n)>=55), ruleTest('Risk-ADX above 25',n=>n.score==null?null:n.score>25),
    ruleTest('Speed ≥ 1.5× or DVOL ≥ 65',n=>spdOf(n)==null?null:(spdOf(n)>=1.5||dvolOf(n)>=65)),
    ruleTest('Speed ≥ 1.5× or DVOL ≥ 65 or Risk-ADX > 25',n=>n.score==null||spdOf(n)==null?null:(spdOf(n)>=1.5||dvolOf(n)>=65||n.score>25)),
    ruleTest('Friday AND Risk-ADX above 25',n=>n.wd===5?(n.score==null?null:n.score>25):null)
  ];
  const baseByWeekday=Object.fromEntries([1,2,3,4,5].map(w=>{const a=nights.filter(n=>n.wd===w);return [w,{n:a.length,stop:sr(a)}];}));

  const out={
    rules, baseByWeekday,
    generated:new Date().toISOString().slice(0,10), nights:N, baseStopPct:+base.toFixed(1), vetoPct:VETO_PCT,
    span:[dkey(nights[0].E),dkey(nights[N-1].E)],
    note:'DVOL as IV, BS legs, stop@2x in 8h, entry 22:30 IST. Skew/term/bid-ask/crush/greeks/funding/futures/macro have no 5y history (live-only).',
    order:ORDER.map(([k,l])=>({k,l,prio:PRIO[k],backtested:BACKTESTED.includes(k)})),
    orient:Object.fromEntries(BACKTESTED.map(k=>[k,meta[k].o])), pct:Object.fromEntries(BACKTESTED.map(k=>[k,meta[k].pct])),
    overall, weekday:groups('wd',[1,2,3,4,5]), weekOfMonth:groups('wom',[1,2,3,4,5]), month:groups('mo',[1,2,3,4,5,6,7,8,9,10,11,12]),
    weights, calibration:cal, composite
  };
  const js=`window.__STRANGLE_INDRANK = ${JSON.stringify(out)};\n`;
  for(const rel of ['../../data/indicator_rank_dynamic.js','../../frontend/public/data/indicator_rank_dynamic.js'])fs.writeFileSync(P(rel),js);
  // ---- console report
  const L=ORDER.reduce((m,[,l])=>Math.max(m,l.length),0);
  console.log(`FIVE-YEAR INDICATOR RANKING — ${N} nights ${out.span.join(' → ')}, base stop ${out.baseStopPct}%, veto = riskiest ${100-VETO_PCT}%`);
  console.log('\nOVERALL (lift pts = stop% in the risky 30% minus stop% in the rest):');
  for(const x of overall)console.log(`  ${(ORDER[PRIO[x.k]-1][1]).padEnd(L)}  lift ${String(x.lift).padStart(5)}   risky ${x.hot}%  rest ${x.rest}%  n=${x.n}  ${meta[x.k].o>0?'high=risk':'low=risk'}`);
  const DN=['','Mon','Tue','Wed','Thu','Fri'];
  console.log('\nBEST 3 BY WEEKDAY:');for(const w of [1,2,3,4,5])console.log(`  ${DN[w]}: `+out.weekday[w].slice(0,3).map(x=>`${ORDER[PRIO[x.k]-1][1]} (+${x.lift})`).join(' · '));
  console.log('\nCOMPOSITE (calibrated so 25 = riskiest-30% cutoff):',JSON.stringify(composite.above25),'vs',JSON.stringify(composite.atOrBelow25));
  console.log('BY YEAR (stop% above25 / at-or-below25):',Object.entries(composite.byYear).map(([y,v])=>`${y}: ${v.above25.stop}% (n${v.above25.n}) / ${v.atOrBelow25.stop}% (n${v.atOrBelow25.n})`).join(' | '));
  console.log('BASE STOP BY WEEKDAY:',Object.entries(baseByWeekday).map(([w,v])=>`${DN[w]} ${v.stop}% (n${v.n})`).join(' | '));
  console.log('RULE TESTS (stop% when the rule fires vs when clear):');for(const r of rules)console.log(`  ${r.name.padEnd(46)} fires ${String(r.fires.stop).padStart(5)}% (n${r.fires.n})   clear ${String(r.clear.stop).padStart(5)}% (n${r.clear.n})`);
  console.log('WEIGHTS:',JSON.stringify(weights));
}
main();
