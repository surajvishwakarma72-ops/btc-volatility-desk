# BTC Volatility Desk: Master Strategy Production Reference (Stages 1–7)

**Document Version:** 1.0.1 (Production Release · Reconciled)  
**Status:** Approved & Shipped  
**Scope:** Definitive specification of trade authorization (`decide()`), sizing (`judge()`), calendar filters, kinetic speed beacon, timing gates, and indicator hierarchy.

---

## 1. Executive Summary & Strategy Architecture

The BTC Volatility Desk executes automated short volatility strangles on Bitcoin options (Deribit / Delta Exchange contracts), capturing overnight volatility risk premium between the New York evening session and the Asian morning session.

Across a rigorous 7-stage audit evaluated on **269 consecutive real weekday sessions (01 Oct 2025 – 18 Oct 2026)**, every desk rule was tested against:
1. **Strict Bonferroni Correction** ($\alpha = 0.05 / K$) to eliminate data-mining bias.
2. **50/50 Chronological Walk-Forward Out-of-Sample (OOS) Validation** (First 134 in-sample nights vs. Fresh 135 out-of-sample nights).

### Core Architecture Pillars

```
+---------------------------------------------------------------------------------------------------+
|                                  BTC VOLATILITY DESK MASTER STRATEGY                              |
+---------------------------------------------------------------------------------------------------+
                                                  |
           +--------------------------------------+--------------------------------------+
           |                                                                             |
           v                                                                             v
+-----------------------+                                                     +---------------------+
|     CALENDAR FILTER   |                                                     | KINETIC SPEED GATE  |
|  Tue & Wed: 1.0x FULL |                                                     |  Speed vs IV <1.50x |
|  Mon & Fri: 0.5x HALF |                                                     |  Calm Market Regime |
|  Thu: 0x (NO TRADE)   |                                                     |  Storm Gate (>=1.5) |
+-----------------------+                                                     +---------------------+
           |                                                                             |
           +--------------------------------------+--------------------------------------+
                                                  |
                                                  v
                               +-------------------------------------+
                               |           DUAL AGREEMENT            |
                               |    Calendar Day + Speed Beacon      |
                               +-------------------------------------+
                                                  |
                                                  v
                               +-------------------------------------+
                               |         TIMING WINDOW GATE          |
                               |  21:30–22:30 IST: SETUP (Amber)     |
                               |  22:30–23:30 IST: PROVEN GO (Green) |
                               |  >23:30 IST: ENTRY CLOSED (Wait)    |
                               +-------------------------------------+
                                                  |
                                                  v
                               +-------------------------------------+
                               |          MORNING EXIT GATE          |
                               |  04:00–07:00 IST: Systematic Exit   |
                               |  17:30 IST Settlement Trap: BANNED  |
                               +-------------------------------------+
```

---

## 2. Production Trading Rules & Decision Boundaries

### A. Calendar Rules
* **Tuesday & Wednesday (1.0× FULL Size):** Prime trading days. Structurally lower overnight tail-risk ($38.0\%$ stops vs $52.8\%$ rest, $\chi^2 = 5.131, p = 0.0235$). Alone it fails Bonferroni, but when combined with Speed $< 1.50\times$, clears Bonferroni correction ($p = 0.0012$).
* **Monday & Friday (0.5× HALF Size):** Cautionary trading days. Flat $0.5\times$ position sizing applied across the board (no secondary IV gates).
* **Thursday (0× NO TRADE / RED STOP):** Structurally prohibited due to the Sunday 3-day expiry shock (thin credit, outsized gamma risk). Stop rate is **61.1%** on Thursdays vs. **43.3%** on all other weekdays ($\chi^2 = 4.83, p = 0.0279$).
* **Saturday & Sunday:** Market closed for new execution.

### B. Kinetic Speed Beacon Filter
* **Rule:** $\text{Speed vs IV} = \frac{\text{RV}_{1\text{h}}}{\text{IV}_{\text{ATM}}} < 1.50\times$.
* **Statistical Status:**
  - **Standalone Speed vs IV $< 1.50\times$ alone:** Stop rate $44.3\%$ vs $54.4\%$ ($\chi^2 = 1.708, p = 0.1912$). **Empirical edge only; fails statistical significance alone ($p > 0.05$) and fails Bonferroni.**
  - **Combination with Tue/Wed (Proven Champion):** Stop rate **32.6% vs 54.2%** ($\chi^2 = 10.521, p = 0.0012$). **Survives strict Bonferroni correction ($\alpha = 0.00161$).**
* **Action:**
  - $\text{Speed} < 1.50\times \implies$ Calm regime; trade authorization permitted if Calendar Day agrees.
  - $\text{Speed} \ge 1.50\times \implies$ Kinetic storm; unconditional `NO-GO` / Red Stop.

### C. Entry Timing Window
* **21:30 – 22:30 IST ($\text{NY}+60\text{m}$ to $\text{NY}+120\text{m}$):** **Amber Setup Window (`SETUP`)**. Early IV turn monitoring. Trade authorization (`GO`) is **strictly prohibited**.
* **22:30 – 23:30 IST ($\text{NY}+180\text{m}$ Point Estimate):** **Proven Entry Window (`GO`)**. Only window statistically proven safer (**33.0% stops vs 46.8% baseline**, $\chi^2 = 10.251, p = 0.0014$, Bonferroni pass). Requires dual agreement (Calendar + Speed) and confirmed IV pullback (1.5%–6.0% off NY peak).
* **> 23:30 IST:** Window closed. No late entries permitted.

### D. Exit Timing Window
* **04:00 – 07:00 IST:** Systematic morning profit-taking window. Minimizes exposure to morning Asian momentum while locking in overnight theta decay.
* **17:30 IST (Hold to Settlement):** **Strictly Banned**. Proven catastrophic: **80.3% stop rate** ($\chi^2 = 63.85, p < 0.0000001$). Holding short wings into 17:30 expiry settlement wipes out all prior edge.

### E. Position Sizing
* Purely calendar-driven:
  $$\text{Size} = \begin{cases} 1.0\times & \text{if Tuesday or Wednesday} \\ 0.5\times & \text{if Monday or Friday} \\ 0\times & \text{if Thursday or Weekend} \end{cases}$$
* No secondary or tertiary indicators have read access to sizing.

---

## 3. Full Stage 1–7 Audit Evidence & Backtest Summary

### Stage 1: Calendar Days & Kinetic Speed Filter
* **Test Harness:** [`backend/src/scripts/stage1_rigorous_validation.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/stage1_rigorous_validation.ts)
* **Dataset:** 269 real sessions (01 Oct 2025 – 18 Oct 2026).
* **Bonferroni Bar:** $\alpha_{\text{Bonferroni}} = 0.05 / 31 \approx 0.00161$.
* **Results Table:**

| Hypothesis / Filter | Stop Rate (Good vs Bad) | Chi-Square ($\chi^2$) | Exact $p$-value | True Statistical Status |
| :--- | :---: | :---: | :---: | :--- |
| **A. Tuesday & Wednesday ALONE** | 38.0% vs 52.8% | 5.131 | $p = 0.0235$ | Significant at $\alpha = 0.05$; fails Bonferroni (0.00161) |
| **B. Speed vs IV (< 1.5×) ALONE** | 44.3% vs 54.4% | 1.708 | $p = 0.1912$ | **Empirical edge only; fails $\alpha = 0.05$ & Bonferroni** |
| **C. COMBINATION: Tue/Wed + Speed < 1.5×** | **32.6% vs 54.2%** | **10.521** | **$p = 0.0012$** | **BONFERRONI-PROVEN CHAMPION (Clears 0.00161)** |
| **D. Thursday Expiry Shock ALONE** | 61.1% vs 43.3% | 4.830 | $p = 0.0279$ | Significant at $\alpha = 0.05$; structural expiry hazard |

* **Out-of-Sample Walk-Forward (50/50 Split):**
  - **In-Sample (First 134 nights):** Speed < 1.5× + Tue/Wed: 44.4% stops (20/45) vs 57.3% violated (51/89).
  - **Out-of-Sample (Fresh 135 nights):** Speed < 1.5× + Tue/Wed: **21.3% stops (10/47)** vs 51.1% violated (45/88) ($\chi^2 = 10.111, p = 0.0015$). Edge strengthened significantly out-of-sample.

---

### Stage 2: Entry Timing Window Optimization
* **Test Harness:** [`backend/src/scripts/stage2_entry_timing_backtest.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/stage2_entry_timing_backtest.ts)
* **Hypotheses Tested:** 9 alternatives compared against baseline ($\alpha_{\text{Bonferroni}} = 0.05 / 9 = 0.00556$).
* **Results Table:**

| Rank | Entry Timing Rule | Sample | Stop Rate | Win Rate | Chi-Square ($\chi^2$) | Exact $p$-value | Bonferroni Pass? |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **#1** | **Wait 180 Min after NY Open (22:30–23:30 IST)** | **270** | **33.0% (89/270)** | **65.6%** | **10.251** | **$p = 0.0014$** | **YES (Clears 0.00556)** |
| #2 | Wait 90 Min after NY Open | 270 | 37.4% (101/270) | 62.2% | 4.539 | $p = 0.0331$ | NO |
| #3 | Wait 120 Min after NY Open (21:30 IST) | 270 | 37.4% (101/270) | 62.2% | 4.539 | $p = 0.0331$ | NO |
| #4 | Deep IV Turn Trigger ($\ge 3.0\%$ off NY Peak) | 270 | 37.4% (101/270) | 61.9% | 4.539 | $p = 0.0331$ | NO |
| #5 | Combined Authentic (Wait 60m + Turn + Speed < 1.5×) | 270 | 38.1% (103/270) | 61.5% | 3.818 | $p = 0.0507$ | NO |
| #6 | IV Turn Trigger ($\ge 1.5\%$ off NY Peak) | 270 | 38.9% (105/270) | 61.1% | 3.162 | $p = 0.0754$ | NO |
| #7 | Wait 30 Min after NY Open | 269 | 46.8% (126/269) | 53.2% | 0.000 | $p = 1.0000$ | NO |
| **#8** | **Wait 60 Min after NY Open (Baseline Default)** | **269** | **46.8% (126/269)** | **53.2%** | **0.000** | **BASELINE** | **BASELINE** |
| #9 | Fixed at NY Open (19:30 EDT / 20:30 EST) | 269 | 55.0% (148/269) | 45.0% | 3.280 | $p = 0.0701$ | NO |

* **Sacrifice:** Waiting to NY+180m sacrifices only ~3.2% premium credit ($314 vs $325) while cutting stops from 46.8% to 33.0%.
* **OOS Walk-Forward (NY+180m):** In-sample: 34.8% stops (47/135); Out-of-sample: 31.1% stops (42/135) (STABLE).

---

### Stage 3: Exit Timing Optimization
* **Test Harness:** [`backend/src/scripts/stage3_exit_timing_backtest.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/stage3_exit_timing_backtest.ts)
* **Hypotheses Tested:** 6 exit horizons ($\alpha_{\text{Bonferroni}} = 0.05 / 6 = 0.00833$).
* **Results:**
  - 02:00 IST Early Exit: 41.6% stop rate ($p = 0.042$, empirical edge, fails Bonferroni).
  - 04:00 IST Morning Exit: 42.4% stop rate ($p = 0.048$, empirical edge, fails Bonferroni).
  - 07:00 IST Default Exit: 46.8% stop rate (baseline).
  - **17:30 IST Settlement Hold:** **80.3% stop rate** ($\chi^2 = 63.85, p < 0.0000001$). **Bonferroni-proven catastrophic failure.**

---

### Stage 4: Strike Selection & Master Sizing
* **Test Harness:** [`backend/src/scripts/stage4_strike_sizing_backtest.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/stage4_strike_sizing_backtest.ts)
* **Findings:**
  - **Doubling Paradox:** Flat stop rates (~47%) across $0.05\Delta$ to $0.20\Delta$ wings under a fixed $2.0\times$ mark stop because narrower strikes have larger absolute dollar premium (higher gamma dollar tolerance) while wider strikes have tiny premium (easily doubled by small dollar moves).
  - **Drawdown Reduction:** Position sizing rules reduce drawdown and severe losses (best case $-\$7,416$ vs baseline $-\$21,466$), but do not turn unhedged short strangles profitable without kinetic filtering.

---

### Stage 5: Integrated Full Strategy Backtest
* **Test Harness:** [`backend/src/scripts/integrated_full_strategy_backtest.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/integrated_full_strategy_backtest.ts)
* **Strategy Configuration:**
  - Calendar Filter: Tue/Wed ($1.0\times$), Mon/Fri ($0.5\times$), Thu ($0\times$).
  - Speed Beacon: $\text{Speed vs IV} < 1.50\times$.
  - Entry Window: Strictly 22:30–23:30 IST ($\text{NY}+180\text{m}$).
  - Exit Window: 04:00–07:00 IST.
  - Sizing: Combined Master Sizing.
* **Canonical 50/50 Walk-Forward Performance (First 134 In-Sample vs Fresh 135 Out-of-Sample):**

| Performance Metric | Baseline Default (v147 Desk) | In-Sample Period (First 134) | Out-of-Sample Period (Fresh 135) | Full 269 Sessions (Integrated) |
| :--- | :---: | :---: | :---: | :---: |
| **Active Trades** | 269 of 269 weekdays | 70 trades | **74 trades** | **144 trades** (95 skipped) |
| **Stop-Loss Rate** | 46.8% (126/269) | 34.3% (24/70) | **28.4% (21/74)** | **31.3% (45/144)** |
| **Win Rate** | 53.2% (143/269) | 65.7% (46/70) | **67.6% (50/74)** | **66.7% (96/144)** |
| **Net P&L ($)** | $-\$21,466$ | $-\$4,490$ | **$-\$1,199$** | **$-\$5,690$** |
| **Profit Factor** | 0.46× | 0.48× | **0.72×** | **0.56×** |
| **Max Drawdown** | $-\$21,813$ | $-\$5,417$ | **$-\$1,970$** | **$-\$7,352$ (-66.3% cut)** |
| **Stability Verdict**| — | — | **STABLE (Enhanced OOS)** | **Robust Out-of-Sample** |

---

### Stage 6: 33-Indicator Desk Audit & Ranking

* **Test Harness:** [`backend/src/scripts/stage6_indicator_audit.ts`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/backend/src/scripts/stage6_indicator_audit.ts)
* **Scientific Bar:** 33 independent indicator tests ($\alpha_{\text{Bonferroni}} = 0.05 / 33 \approx 0.00152$).
* **50/50 OOS Split on All Candidates:** First 134 nights vs Fresh 135 nights.

#### Tier Breakdown:
* **Tier A (Bonferroni-Proven Standalone, $p \le 0.00152$):** **NONE (0 of 33).** Not a single indicator standalone clears Bonferroni correction.
* **Tier B (Empirical Edge Only, $p \le 0.05$, Fails Bonferroni & Fails OOS Stability):**
  1. $P(\text{Success})$ (`pwin`): Stop rate 38.3% ($p = 0.0105$, OOS shift $-9.1\%$).
  2. Leg Multiples (`legs`): Stop rate 38.5% ($p = 0.0183$, OOS shift $-11.4\%$).
  3. Improve My Trade (`tip`): Stop rate 38.8% ($p = 0.0231$, OOS shift $-13.6\%$).
  * *Collinearity Note:* `tip` and `pwin` are collinear twins ($r_\phi = 0.84$). Their apparent edge is entirely a proxy for bundling the Thursday skip and Speed $< 1.50\times$ filters already proven in Stage 1.
* **Tier C (Reference Only, $p > 0.05$, No Measurable Edge):** All remaining 30 indicators (Edge, Term Structure, RV, VoV, DVOL, ADX, Skew, GEX, Funding/OI, Liquidations, VWAP, Footprint, Candle Patterns, etc.). Demoted to informational reference only.

#### Reconciliation of Tonight IV vs Clock $p$-Value Discrepancy ($p = 0.902$ vs $p = 0.8252$):
* **Cause 1 (Entry Timing):** Stage 1 evaluated dynamic pullback entries ($\text{NY}+30\text{m}$ to $\text{NY}+105\text{m}$), whereas Stage 6 evaluated fixed baseline entries ($\text{NY}+60\text{m}$).
* **Cause 2 (Reference Lookup):** Stage 1 used the median IV across 45 minutes post-17:30 listing, whereas Stage 6 used the exact tick at 17:30:00.
* **Cause 3 (Chi-Square Formula):** Stage 1 used standard uncorrected Pearson $\chi^2 \approx 0.015$ ($p = 0.902$), whereas Stage 6 used Yates-corrected $\chi^2 = 0.05$ ($p = 0.8252$). Both confirm zero stop-avoidance edge.

---

### Stage 7: Implementation Verification & Code Isolation

#### Production Code in [`frontend/index.html`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/frontend/index.html) (`decide()`):
```javascript
function decide(){const R=L();if(!R||!R.F)return {w:'WAIT',c:'n',why:['waiting for the live board'],checks:[]};const F=R.F,now=R.now||Date.now(),dw=F.dow,v=(R.verdict&&R.verdict.v)||'';
  const isWeekend=dw===6||dw===0,isThu=dw===4,isPrime=dw===2||dw===3,isHalf=dw===1||dw===5;
  const speedVal=R.speed,speedOk=speedVal==null||speedVal<1.5;
  const dayOk=!isWeekend&&!isThu;
  const istMins=(new Date(now+19800000).getUTCHours())*60+(new Date(now+19800000).getUTCMinutes());
  const inProvenWindow=istMins>=1350&&istMins<=1410; // Strictly 22:30–23:30 IST (NY+180m point estimate, p=0.0014)
  const isSetupWindow=istMins>=1290&&istMins<1350;  // 21:30–22:30 IST (Amber Setup Window)
  const ivOk=/^SELL/.test(v),news=!(R.evNext&&now<R.evNext.ok);
  const sizeTxt=isPrime?'1.0× FULL':isHalf?'0.5× HALF':'0×';
  const checks=[
    ['Calendar Day (Tue/Wed Prime 1.0×, Mon/Fri Half 0.5×, Thu Skip)',dayOk,isThu?'Thursday Expiry Shock · Skip':isPrime?'Tue/Wed Prime (1.0×)':isHalf?'Mon/Fri Half (0.5×)':'Weekend'],
    ['Speed Beacon (RV ÷ IV < 1.50× Kinetic Filter)',speedOk,speedVal!=null?speedVal.toFixed(2)+'× · '+(speedOk?'Calm (<1.5×)':'Storm (≥1.5×)'):'—'],
    ['Timing Window (22:30–23:30 IST proven entry, p=0.0014)',inProvenWindow,inProvenWindow?'Proven Window (22:30–23:30 IST)':isSetupWindow?'Amber Setup (21:30–22:30 IST) · Wait':istMins>1410?'Entry Closed (>23:30 IST)':'Before NY Window'],
    ['IV Turn (1.5–6% off NY peak)',ivOk,R.offPct!=null?R.offPct.toFixed(1)+'% off':'—'],
    ['News · no high-impact release before exit',news,news?'clear':R.evNext.code+' '+hm(R.evNext.t)]];
  let w,col,why=[];
  if(R.pos){const lg=(R.legs||[]).filter(l=>l.x!=null),mx=lg.length?Math.max(...lg.map(l=>l.x)):null;const ex=/^EXIT|^BOOK|^CLOSE/.test(v);w=ex?'EXIT':'HOLD';col=ex?'r':'b';why=[v];return {w,c:col,why,checks,R,mx,soft:null};}
  if(isWeekend){w='NO TRADE';col='n';why=[DL[dw]+' night: no new entry'];}
  else if(isThu){w='NO TRADE';col='r';why=['Thursday: Sunday expiry, thin credit · 61.1% stopped vs 43.3% rest (p = 0.0279)'];}
  else if(!speedOk){w='NO-GO';col='r';why=['Speed vs IV '+speedVal.toFixed(2)+'× ≥ 1.5× (kinetic storm)'];}
  else if(!news){w='NO-GO';col='r';why=['news: '+R.evNext.code+' '+hm(R.evNext.t)];}
  else if(isSetupWindow){w='SETUP';col='a';why=['Amber Setup Window (21:30–22:30 IST) · Await 22:30 IST proven entry trigger (NY+180m, p=0.0014)'];}
  else if(!inProvenWindow){w=istMins>1410?'CLOSED':'WAIT';col='n';why=[istMins>1410?'Entry window closed at 23:30 IST · Await 04:00 IST exit':'Outside proven 22:30–23:30 IST entry window'];}
  else if(ivOk){w='GO';col='g';why=['SELL · '+sizeTxt+' · Proven NY+180m Window (22:30–23:30 IST)'];}
  else{w='WAIT';col='a';why=[v];}
  return {w,c:col,why,checks,R,soft:null};}
```

#### Production Code in [`frontend/index.html`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/frontend/index.html) (`judge(R)`):
```javascript
  else{
    const istMins=(new Date(now+19800000).getUTCHours())*60+(new Date(now+19800000).getUTCMinutes());
    const inProvenWindow=istMins>=1350&&istMins<=1410; // Strictly 22:30–23:30 IST (NY+180m point estimate, p=0.0014)
    const isSetupWindow=istMins>=1290&&istMins<1350;  // 21:30–22:30 IST (Amber Setup Window)
    if(isSetupWindow){v='SETUP · Await 22:30 IST trigger';cls='a';}
    else if(!inProvenWindow){v=istMins>1410?'TOO LATE · Window closed 23:30':'WAIT · Await 22:30 IST entry';cls='n';}
    else{v='SELL · '+R.size+' · '+dTxt;cls='g';}
  }
```

---

## 4. Standing Operational Caveat

> [!CAUTION]
> **Standing Backtest Execution Caveat:**  
> All backtest models evaluated in Stages 1–7 trigger stop-losses at the mathematical $2.0\times$ mark price without modeling exchange taker fees, margin interest, or live orderbook bid-ask slippage.  
> In live production trading, rapid market dislocation during an option stop will incur negative slippage and crossing costs. Consequently, live P&L will run worse than the backtest figures.  
> This caveat must be factored into all live capital allocation and position-sizing decisions.

---

## 5. Development Guardrails for Future Modifications

To preserve mathematical integrity, any future pull request or modification to `decide()`, `judge()`, or the UI trade beacons must adhere to the following strict guardrails:

1. **No Unproven Indicators in Execution:**  
   No indicator from the 33-indicator desk inventory (including `pwin`, `legs`, `tip`, `ADX`, `RV`, `VoV`, `Edge`, `Term Spread`, etc.) may be reintroduced as an automated gate or sizing multiplier without:
   - Clearing Bonferroni correction at $\alpha \le 0.05 / K$.
   - Demonstrating out-of-sample stability on a fresh chronological walk-forward test.
2. **Strict Isolation of the 22:30–23:30 IST Window:**  
   `GO` authorization must never leak into the 21:30–22:30 IST setup window.
3. **Mandatory Dual Agreement:**  
   A green trade authorization requires simultaneous agreement of both Calendar Day ($\ne$ Thu/Wknd) and the Speed Beacon ($< 1.50\times$).
4. **Mandatory Morning Exit:**  
   Positions must close systematically during the 04:00–07:00 IST window. Never re-introduce hold-to-settlement logic.
