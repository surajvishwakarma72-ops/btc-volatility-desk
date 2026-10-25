# Final short-strangle search: next or N2N expiry, OTM delta, entry hour, hold, stop, entry gate
Pricing: DVOL x 0.881 as flat IV, Black-Scholes, 1.2% half-spread (min $1), Delta fees + GST, 100 lots/leg. 2592 base rules x 5 gates = 12960 rule sets.
Periods: TRAIN 2021-11-30..2024-04-25 | VALID ..2025-10-25 | HOLDOUT ..2026-10-20 (never used to pick).

## How widespread is profit?
Rule sets with enough trades in train and validation: 12960. Positive in train: 3014. Positive in train AND validation: 2398. Of those, positive in the untouched holdout: 543 (23%).
Train t >= 4.3 (bar for 12960 tests): 30; also valid t >= 2: 29.
Gate "none": 2592 sets, average per trade train -$0.88 | valid -$2.05 | holdout -$3.71; positive in train+valid: 344
Gate "DVOL<55": 2592 sets, average per trade train -$0.69 | valid -$1.50 | holdout -$3.39; positive in train+valid: 433
Gate "DVOL falling 24h": 2592 sets, average per trade train -$0.40 | valid -$0.57 | holdout -$2.08; positive in train+valid: 789
Gate "DVOL above its 30d median": 2592 sets, average per trade train -$1.74 | valid -$4.11 | holdout -$5.56; positive in train+valid: 10
Gate "IV richer than 24h RV": 2592 sets, average per trade train -$0.37 | valid -$0.35 | holdout -$1.69; positive in train+valid: 822
Expiry next: average per trade train -$0.68 | valid -$1.28 | holdout -$3.05; positive in train+valid: 1667
Expiry N2N: average per trade train -$0.95 | valid -$2.16 | holdout -$3.53; positive in train+valid: 731

## Top 15 by the weaker of train/valid t-stat (picked WITHOUT looking at the holdout), shown with their holdout
IST 05:00 | next expiry | delta 0.125 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.25 t=5.0 (n 533) | valid $2.90 t=5.0 (n 291) | HOLDOUT $0.24 t=0.4 (n 145) win 50% stop 50%
IST 05:00 | next expiry | delta 0.1 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $0.98 t=4.9 (n 533) | valid $2.53 t=5.5 (n 291) | HOLDOUT $0.55 t=1.0 (n 145) win 52% stop 50%
IST 07:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.93 t=4.7 (n 530) | valid $4.94 t=5.7 (n 294) | HOLDOUT $0.53 t=0.5 (n 150) win 51% stop 49%
IST 06:00 | next expiry | delta 0.2 | hold 12h | stop 3x | gate: DVOL falling 24h || train $2.71 t=4.7 (n 373) | valid $6.14 t=5.2 (n 230) | HOLDOUT $3.29 t=2.6 (n 153) win 75% stop 18%
IST 11:00 | next expiry | delta 0.15 | hold 6h | stop none | gate: IV richer than 24h RV || train $1.02 t=4.5 (n 523) | valid $2.42 t=4.6 (n 291) | HOLDOUT $0.49 t=0.7 (n 143) win 78% stop 0%
IST 08:00 | next expiry | delta 0.15 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.34 t=4.5 (n 528) | valid $3.37 t=4.9 (n 294) | HOLDOUT $0.14 t=0.2 (n 142) win 49% stop 54%
IST 04:00 | next expiry | delta 0.15 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.27 t=4.5 (n 532) | valid $3.24 t=4.8 (n 286) | HOLDOUT $0.06 t=0.1 (n 144) win 51% stop 49%
IST 05:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.88 t=4.7 (n 533) | valid $3.87 t=4.5 (n 291) | HOLDOUT -$0.07 t=-0.1 (n 145) win 52% stop 48%
IST 08:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.70 t=4.5 (n 528) | valid $3.92 t=4.4 (n 294) | HOLDOUT -$0.53 t=-0.5 (n 142) win 46% stop 54%
IST 11:00 | next expiry | delta 0.2 | hold 6h | stop none | gate: IV richer than 24h RV || train $1.25 t=4.6 (n 523) | valid $2.70 t=4.4 (n 291) | HOLDOUT $0.40 t=0.5 (n 143) win 78% stop 0%
IST 04:00 | next expiry | delta 0.2 | hold 24h | stop 2x | gate: DVOL falling 24h || train $2.94 t=4.4 (n 382) | valid $6.98 t=4.5 (n 228) | HOLDOUT $1.99 t=1.4 (n 154) win 38% stop 64%
IST 05:00 | next expiry | delta 0.2 | hold 24h | stop 2x | gate: DVOL falling 24h || train $2.75 t=4.3 (n 375) | valid $6.56 t=4.3 (n 229) | HOLDOUT $2.52 t=1.8 (n 147) win 38% stop 64%
IST 04:00 | next expiry | delta 0.125 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.03 t=4.3 (n 532) | valid $2.86 t=4.9 (n 286) | HOLDOUT $0.65 t=1.1 (n 144) win 51% stop 49%
IST 08:00 | next expiry | delta 0.1 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $0.84 t=4.3 (n 528) | valid $2.59 t=5.5 (n 294) | HOLDOUT $0.40 t=0.7 (n 142) win 48% stop 55%
IST 05:00 | next expiry | delta 0.15 | hold 12h | stop 2x | gate: IV richer than 24h RV || train $1.36 t=4.3 (n 533) | valid $3.14 t=4.6 (n 291) | HOLDOUT $0.27 t=0.3 (n 145) win 51% stop 50%

## Leading picks re-run with the REAL archived IV (last 13 months)
IST 05:00 | next expiry | delta 0.125 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 147 trades: -$4.23/trade, total -$621, t=-5.6
IST 05:00 | next expiry | delta 0.1 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 147 trades: -$3.11/trade, total -$458, t=-4.8
IST 07:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 153 trades: -$6.14/trade, total -$940, t=-5.1
IST 06:00 | next expiry | delta 0.2 | hold 12h | stop 3x | gate: DVOL falling 24h || real-IV 157 trades: -$3.99/trade, total -$627, t=-2.7
IST 11:00 | next expiry | delta 0.15 | hold 6h | stop none | gate: IV richer than 24h RV || real-IV 145 trades: -$3.34/trade, total -$485, t=-3.3
IST 08:00 | next expiry | delta 0.15 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 144 trades: -$5.29/trade, total -$762, t=-7.1
IST 04:00 | next expiry | delta 0.15 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 146 trades: -$4.76/trade, total -$695, t=-5.6
IST 05:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 147 trades: -$6.60/trade, total -$970, t=-5.8
IST 08:00 | next expiry | delta 0.2 | hold 12h | stop 2x | gate: IV richer than 24h RV || real-IV 144 trades: -$7.45/trade, total -$1072, t=-7.5
IST 11:00 | next expiry | delta 0.2 | hold 6h | stop none | gate: IV richer than 24h RV || real-IV 145 trades: -$3.92/trade, total -$569, t=-3.4

## Verdict
No rule set was positive in train, validation, the untouched holdout AND the real-IV re-check. There is no short strangle in this grid that the data supports trading.
Least bad overall (average of the three periods): IST 06:00 | next expiry | delta 0.2 | hold 12h | stop 3x | gate: DVOL falling 24h || train $2.71 t=4.7 (n 373) | valid $6.14 t=5.2 (n 230) | HOLDOUT $3.29 t=2.6 (n 153) win 75% stop 18%

## Evening candidates (found on the 13 real-IV months) checked on the five-year model, by year
IST 19:00 | N2N expiry | delta 0.1 | hold 24h | stop none | gate: DVOL falling 24h || 5y n 757 mean -$0.08 t=-0.1 win 75% | 2021-22 -$4.32 (n 143) | 2022-23 $0.35 (n 157) | 2023-24 $1.37 (n 138) | 2024-25 $1.83 (n 151) | 2025-26 $0.20 (n 168)
IST 19:00 | N2N expiry | delta 0.125 | hold 24h | stop none | gate: DVOL falling 24h || 5y n 757 mean $0.17 t=0.1 win 75% | 2021-22 -$4.40 (n 143) | 2022-23 $0.76 (n 157) | 2023-24 $1.44 (n 138) | 2024-25 $2.27 (n 151) | 2025-26 $0.58 (n 168)
IST 19:00 | N2N expiry | delta 0.15 | hold 24h | stop none | gate: DVOL falling 24h || 5y n 757 mean $0.16 t=0.1 win 74% | 2021-22 -$4.66 (n 143) | 2022-23 $0.48 (n 157) | 2023-24 $1.86 (n 138) | 2024-25 $2.49 (n 151) | 2025-26 $0.49 (n 168)
IST 19:00 | N2N expiry | delta 0.2 | hold 24h | stop none | gate: DVOL falling 24h || 5y n 757 mean $0.73 t=0.5 win 74% | 2021-22 -$4.73 (n 143) | 2022-23 $1.33 (n 157) | 2023-24 $2.46 (n 138) | 2024-25 $3.43 (n 151) | 2025-26 $0.97 (n 168)
IST 21:00 | next expiry | delta 0.1 | hold 12h | stop none | gate: DVOL falling 24h || 5y n 771 mean -$0.47 t=-0.8 win 77% | 2021-22 -$2.47 (n 153) | 2022-23 $0.42 (n 156) | 2023-24 -$1.05 (n 143) | 2024-25 $0.06 (n 158) | 2025-26 $0.56 (n 161)
IST 21:00 | next expiry | delta 0.15 | hold 12h | stop none | gate: DVOL falling 24h || 5y n 771 mean -$0.66 t=-0.8 win 75% | 2021-22 -$2.59 (n 153) | 2022-23 $0.52 (n 156) | 2023-24 -$1.66 (n 143) | 2024-25 -$0.42 (n 158) | 2025-26 $0.68 (n 161)
IST 21:00 | next expiry | delta 0.2 | hold 12h | stop none | gate: DVOL falling 24h || 5y n 771 mean -$0.68 t=-0.7 win 75% | 2021-22 -$2.73 (n 153) | 2022-23 $1.12 (n 156) | 2023-24 -$2.05 (n 143) | 2024-25 -$0.54 (n 158) | 2025-26 $0.63 (n 161)
IST 19:00 | N2N expiry | delta 0.1 | hold 24h | stop none | gate: none || 5y n 1505 mean -$3.61 t=-3.3 win 73% | 2021-22 -$4.14 (n 273) | 2022-23 -$2.31 (n 308) | 2023-24 -$3.05 (n 309) | 2024-25 -$2.13 (n 302) | 2025-26 -$6.41 (n 313)
IST 19:00 | N2N expiry | delta 0.15 | hold 24h | stop none | gate: none || 5y n 1505 mean -$4.09 t=-3.2 win 72% | 2021-22 -$4.45 (n 273) | 2022-23 -$2.40 (n 308) | 2023-24 -$3.00 (n 309) | 2024-25 -$2.44 (n 302) | 2025-26 -$8.11 (n 313)
IST 19:00 | N2N expiry | delta 0.2 | hold 24h | stop none | gate: none || 5y n 1505 mean -$4.19 t=-2.9 win 71% | 2021-22 -$4.68 (n 273) | 2022-23 -$1.99 (n 308) | 2023-24 -$2.97 (n 309) | 2024-25 -$2.49 (n 302) | 2025-26 -$8.75 (n 313)
Caveat: 12960 rule sets were compared, so even a rule that passes all stages may be luck; flat IV ignores skew; spreads are assumed, not recorded.
