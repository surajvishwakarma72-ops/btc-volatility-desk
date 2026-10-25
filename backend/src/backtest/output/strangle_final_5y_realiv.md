# Final short-strangle search: next or N2N expiry, OTM delta, entry hour, hold, stop, entry gate
Pricing: DVOL x 0.881 as flat IV, Black-Scholes, 1.2% half-spread (min $1), Delta fees + GST, 100 lots/leg. 2592 base rules x 5 gates = 12960 rule sets.
Periods: TRAIN 2025-10-06..2026-03-01 | VALID ..2026-06-15 | HOLDOUT ..2026-10-20 (never used to pick).

## How widespread is profit?
Rule sets with enough trades in train and validation: 9990. Positive in train: 387. Positive in train AND validation: 111. Of those, positive in the untouched holdout: 46 (41%).
Train t >= 4.3 (bar for 12960 tests): 2; also valid t >= 2: 0.
Gate "none": 2592 sets, average per trade train -$6.41 | valid -$2.36 | holdout -$3.33; positive in train+valid: 0
Gate "DVOL<55": 2592 sets, average per trade train -$5.77 | valid -$2.28 | holdout -$3.62; positive in train+valid: 2
Gate "DVOL falling 24h": 2592 sets, average per trade train -$4.88 | valid -$1.01 | holdout -$2.50; positive in train+valid: 67
Gate "DVOL above its 30d median": 0 sets, average per trade train $0.00 | valid $0.00 | holdout $0.00; positive in train+valid: 0
Gate "IV richer than 24h RV": 2214 sets, average per trade train -$5.17 | valid -$3.20 | holdout -$3.93; positive in train+valid: 42
Expiry next: average per trade train -$5.44 | valid -$2.12 | holdout -$3.51; positive in train+valid: 67
Expiry N2N: average per trade train -$5.71 | valid -$2.23 | holdout -$3.13; positive in train+valid: 44

## Top 15 by the weaker of train/valid t-stat (picked WITHOUT looking at the holdout), shown with their holdout
IST 19:00 | N2N expiry | delta 0.2 | hold 24h | stop none | gate: DVOL falling 24h || train $5.63 t=1.4 (n 50) | valid $6.43 t=1.8 (n 45) | HOLDOUT $2.33 t=0.9 (n 58) win 66% stop 0%
IST 19:00 | N2N expiry | delta 0.15 | hold 24h | stop none | gate: DVOL falling 24h || train $4.53 t=1.4 (n 50) | valid $4.42 t=1.6 (n 45) | HOLDOUT $2.27 t=1.2 (n 58) win 64% stop 0%
IST 19:00 | N2N expiry | delta 0.08 | hold 24h | stop none | gate: DVOL falling 24h || train $2.43 t=1.3 (n 50) | valid $2.43 t=1.3 (n 45) | HOLDOUT $0.97 t=0.8 (n 58) win 67% stop 0%
IST 19:00 | N2N expiry | delta 0.125 | hold 24h | stop none | gate: DVOL falling 24h || train $3.58 t=1.3 (n 50) | valid $3.93 t=1.6 (n 45) | HOLDOUT $1.82 t=1.0 (n 58) win 62% stop 0%
IST 19:00 | N2N expiry | delta 0.05 | hold 24h | stop none | gate: DVOL falling 24h || train $1.41 t=1.2 (n 50) | valid $1.45 t=1.2 (n 45) | HOLDOUT $0.44 t=0.6 (n 58) win 66% stop 0%
IST 19:00 | N2N expiry | delta 0.1 | hold 24h | stop none | gate: DVOL falling 24h || train $2.88 t=1.2 (n 50) | valid $3.41 t=1.8 (n 45) | HOLDOUT $1.52 t=1.1 (n 58) win 66% stop 0%
IST 21:00 | next expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h || train $3.86 t=0.9 (n 65) | valid $3.61 t=1.4 (n 48) | HOLDOUT $5.89 t=4.3 (n 52) win 83% stop 0%
IST 02:00 | next expiry | delta 0.15 | hold 12h | stop none | gate: DVOL falling 24h || train $1.78 t=0.8 (n 59) | valid $2.20 t=1.1 (n 42) | HOLDOUT $0.00 t=0.0 (n 48) win 60% stop 0%
IST 02:00 | next expiry | delta 0.08 | hold 24h | stop none | gate: IV richer than 24h RV || train $1.46 t=0.8 (n 51) | valid $1.51 t=0.8 (n 42) | HOLDOUT -$10.53 t=-1.3 (n 54) win 72% stop 0%
IST 03:00 | next expiry | delta 0.125 | hold 24h | stop none | gate: IV richer than 24h RV || train $3.13 t=0.9 (n 49) | valid $2.04 t=0.7 (n 40) | HOLDOUT -$9.08 t=-1.0 (n 54) win 74% stop 0%
IST 02:00 | next expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h || train $1.82 t=0.7 (n 59) | valid $1.97 t=0.8 (n 42) | HOLDOUT $1.16 t=0.6 (n 48) win 67% stop 0%
IST 04:00 | next expiry | delta 0.05 | hold 24h | stop none | gate: IV richer than 24h RV || train $1.63 t=1.3 (n 45) | valid $0.81 t=0.7 (n 45) | HOLDOUT -$8.26 t=-1.4 (n 56) win 77% stop 0%
IST 02:00 | N2N expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h || train $3.76 t=2.0 (n 54) | valid $1.34 t=0.6 (n 42) | HOLDOUT $0.75 t=0.4 (n 47) win 64% stop 0%
IST 04:00 | next expiry | delta 0.08 | hold 24h | stop none | gate: IV richer than 24h RV || train $1.90 t=0.9 (n 45) | valid $1.22 t=0.6 (n 45) | HOLDOUT -$9.01 t=-1.3 (n 56) win 71% stop 0%
IST 00:00 | next expiry | delta 0.125 | hold 24h | stop none | gate: IV richer than 24h RV || train $2.23 t=0.6 (n 52) | valid $1.69 t=0.8 (n 43) | HOLDOUT -$6.62 t=-1.1 (n 56) win 71% stop 0%

## Leading picks re-run with the REAL archived IV (last 13 months)
IST 19:00 | N2N expiry | delta 0.2 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $4.61/trade, total $706, t=2.4
IST 19:00 | N2N expiry | delta 0.15 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $3.64/trade, total $557, t=2.4
IST 19:00 | N2N expiry | delta 0.08 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $1.88/trade, total $287, t=2.0
IST 19:00 | N2N expiry | delta 0.125 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $3.01/trade, total $461, t=2.2
IST 19:00 | N2N expiry | delta 0.05 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $1.05/trade, total $161, t=1.8
IST 19:00 | N2N expiry | delta 0.1 | hold 24h | stop none | gate: DVOL falling 24h || real-IV 153 trades: $2.52/trade, total $386, t=2.3
IST 21:00 | next expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h || real-IV 165 trades: $4.43/trade, total $731, t=2.3
IST 02:00 | next expiry | delta 0.15 | hold 12h | stop none | gate: DVOL falling 24h || real-IV 149 trades: $1.33/trade, total $198, t=1.2
IST 02:00 | next expiry | delta 0.08 | hold 24h | stop none | gate: IV richer than 24h RV || real-IV 147 trades: -$2.93/trade, total -$431, t=-0.9
IST 03:00 | next expiry | delta 0.125 | hold 24h | stop none | gate: IV richer than 24h RV || real-IV 143 trades: -$1.79/trade, total -$256, t=-0.5

## Verdict
Best rule set that passed every stage: IST 21:00 | next expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h
Train $3.86/trade (n 65), valid $3.61 (n 48), holdout $5.89 (n 52); holdout win 83%, stop rate 0%, holdout max drawdown $39.
Average portfolio margin per trade $79; holdout mean as % of margin 7.44% per trade.
By year: 2021-22 $0.00 (n 0) | 2022-23 $0.00 (n 0) | 2023-24 $0.00 (n 0) | 2024-25 $12.48 (n 6) | 2025-26 $4.13 (n 159)
By weekday: Sun $6.49 (n 12) | Mon $5.98 (n 27) | Tue $6.05 (n 21) | Wed $2.14 (n 23) | Thu -$2.11 (n 23) | Fri $11.79 (n 31) | Sat -$0.05 (n 28)
Caveat: 12960 rule sets were compared, so even a rule that passes all stages may be luck; flat IV ignores skew; spreads are assumed, not recorded.
