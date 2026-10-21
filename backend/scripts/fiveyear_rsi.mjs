/**
 * FIVE-YEAR RSI BACKTEST across timeframes (1h vs 4h). Does RSI level at entry predict the overnight
 * strangle's stop — and does overbought RSI skew the stop to the CALL leg (oversold → PUT)? Also a
 * direct test of the desk's old "RSI(14) > 60 skip" rule. Legs BS-modelled (DVOL IV, 0.15Δ, stop@2×).
 * Honest caveats: DVOL=30d IV; 1h/4h bars; modelled legs.
 * Run: node scripts/fiveyear_rsi.mjs
 */
import fs from 'node:fs';
const P=(u)=>decodeURIComponent(new URL(u,import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,'$1');
const HOUR=3600_000,DAY=86400_000,YR=365*DAY;
function ncdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
function ninv(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],dd=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const pl=0.02425,ph=1-pl;let q,r;if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1);}
function bs(S,K,T,sig,cp){if(T<=0||sig<=0)return Math.max(cp==='c'?S-K:K-S,0);const v=sig*Math.sqrt(T),d1=(Math.log(S/K)+0.5*sig*sig*T)/v,d2=d1-v;return cp==='c'?S*ncdf(d1)-K*ncdf(d2):K*ncdf(-d2)-S*ncdf(-d1);}
function strikeK(S,T,sig,delta,cp){const v=sig*Math.sqrt(T),d1=ninv(cp==='c'?delta:1-delta);return S*Math.exp(0.5*sig*sig*T-d1*v);}
const dkey=(ts)=>new Date(ts).toISOString().slice(0,10);
// Wilder RSI(14) over close series bars [{t,c}] → Map(t→rsi)
function rsiSeries(bars,per=14){const out=new Map();if(bars.length<per+2)return out;let ag=0,al=0;
  for(let i=1;i<bars.length;i++){const ch=bars[i].c-bars[i-1].c,g=Math.max(ch,0),l=Math.max(-ch,0);
    if(i<=per){ag+=g;al+=l;if(i===per){ag/=per;al/=per;out.set(bars[i].t,100-100/(1+(al===0?100:ag/al)));}continue;}
    ag=(ag*(per-1)+g)/per;al=(al*(per-1)+l)/per;out.set(bars[i].t,100-100/(1+(al===0?100:ag/al)));}
  return out;}

function main(){
  const prices=JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'),'utf8'));const byT=new Map();for(const b of prices)byT.set(b[0],b);
  const b1=prices.map(b=>({t:b[0],c:b[3]}));
  const g4=new Map();for(const b of prices){const k=Math.floor(b[0]/(4*HOUR))*4*HOUR;g4.set(k,{t:k,c:b[3]});}
  const b4=[...g4.values()].sort((a,b)=>a.t-b.t);
  const r1=rsiSeries(b1),r4=rsiSeries(b4);
  const at1=(t)=>{let k=t;for(let i=0;i<6;i++){if(r1.has(k))return r1.get(k);k-=HOUR;}return null;};
  const at4=(t)=>{let k=Math.floor(t/(4*HOUR))*4*HOUR;for(let i=0;i<6;i++){if(r4.has(k))return r4.get(k);k-=4*HOUR;}return null;};
  const dvol=JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'),'utf8'));const dv=new Map();for(const[ts,v]of dvol)dv.set(dkey(ts),v);
  const T0=3/365;
  const mk=()=>[[0,30,'<30 oversold'],[30,45,'30–45'],[45,55,'45–55 neutral'],[55,70,'55–70'],[70,101,'70+ overbought']].map(([lo,hi,lab])=>({lo,hi,lab,n:0,s:0,sc:0,sp:0}));
  const a1=mk(),a4=mk();let over60={n:0,s:0},le60={n:0,s:0},total=0;
  const first=prices[0][0],last=prices[prices.length-1][0];
  for(let d=Math.ceil(first/DAY)*DAY;d<last;d+=DAY){
    const E=d+17*HOUR;const w=new Date(E).getUTCDay();if(w<1||w>5)continue;
    const entry=byT.get(E);const ivPct=dv.get(dkey(E));if(!entry||ivPct==null||!(entry[3]>0))continue;
    const x1=at1(E),x4=at4(E);if(x1==null||x4==null)continue;
    const S0=entry[3],iv=ivPct/100;const Kc=strikeK(S0,T0,iv,0.15,'c'),Kp=strikeK(S0,T0,iv,0.15,'p');
    const c0=bs(S0,Kc,T0,iv,'c'),p0=bs(S0,Kp,T0,iv,'p');if(!(c0>0)||!(p0>0))continue;
    let sc=false,sp=false,have=0;
    for(let h=0;h<=8;h++){const b=byT.get(E+h*HOUR);if(!b)continue;have++;const T=Math.max(T0-h*HOUR/YR,1/365/24);if(bs(b[1],Kc,T,iv,'c')>=2*c0)sc=true;if(bs(b[2],Kp,T,iv,'p')>=2*p0)sp=true;}
    if(have<6)continue;const stop=sc||sp;total++;
    const put1=a1.find(x=>x1>=x.lo&&x1<x.hi);if(put1){put1.n++;if(stop)put1.s++;if(sc)put1.sc++;if(sp)put1.sp++;}
    const put4=a4.find(x=>x4>=x.lo&&x4<x.hi);if(put4){put4.n++;if(stop)put4.s++;}
    if(x1>60){over60.n++;if(stop)over60.s++;}else{le60.n++;if(stop)le60.s++;}
  }
  const pct=(n,dd)=>(dd?(n/dd*100).toFixed(1):'—');
  console.log('='.repeat(84));
  console.log(`FIVE-YEAR RSI — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0,10)}→${new Date(last).toISOString().slice(0,10)})`);
  console.log('='.repeat(84));
  console.log('\n1) RSI(14) 1h at entry — with call/put stop split:');
  console.log('  bucket          n    stop%   callStop%  putStop%');
  for(const x of a1)if(x.n)console.log(`  ${x.lab.padEnd(14)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}    ${pct(x.sc,x.n).padStart(6)}    ${pct(x.sp,x.n).padStart(6)}`);
  console.log('\n2) RSI(14) 4h at entry:');
  console.log('  bucket          n    stop%');
  for(const x of a4)if(x.n)console.log(`  ${x.lab.padEnd(14)} ${String(x.n).padStart(4)}   ${pct(x.s,x.n).padStart(5)}`);
  console.log('\n3) The old "RSI(14) 1h > 60 SKIP" rule:');
  console.log(`  RSI > 60 : ${String(over60.n).padStart(4)}  stop ${pct(over60.s,over60.n)}%`);
  console.log(`  RSI ≤ 60 : ${String(le60.n).padStart(4)}  stop ${pct(le60.s,le60.n)}%`);
  console.log('\n  Reads: does RSI level predict stops / which leg; is the >60 veto justified; which timeframe separates?');
}
main();
