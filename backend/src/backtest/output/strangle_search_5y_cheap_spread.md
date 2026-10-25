# Five-year short strangle search
Data: Binance 15m 2021-10-20 to 2026-10-24, DVOL x 0.881 as flat IV (calibrated on 313 days of real N2N ATM IV; monthly ratios 2025-10 0.88, 2025-11 0.92, 2025-12 0.84, 2026-01 0.91, 2026-02 0.99, 2026-03 0.96, 2026-04 0.91, 2026-05 0.82, 2026-06 0.93, 2026-07 0.88, 2026-08 0.83, 2026-09 0.87, 2026-10 0.81).
Grid: 24 entry hours (IST) x 8 deltas x 4 holds x 3 stops x 2 take-profits = 4608 combos, each traded every day, 100 lots/leg, N2N expiry. Train 2021-11-02 to 2025-04-25, test after.
Costs: 0.2% half-spread (min $0.1) each way (optimistic), Delta option fee + GST. No gate, no skew, flat IV.

## Is profit widespread?
Combos with a positive average in TRAIN: 727/4608 (15.8%). Positive in BOTH train and test: 100 (2.2%).
Train t-stat of at least 4.1 (the bar for 4608 tests): 17. Of those, still positive in test: 9; with test t >= 2: 0.
Median combo: train -$1.18/trade, test -$2.32/trade.

## Top 15 by TRAIN t-stat (what the search would have picked), with their TEST result
IST 07:00 | delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.50/tr t=5.1 win 64% | test $0.26/tr t=1.5 win 53% | yrs+ 4/5 [0.7, 0.3, 0.5, 0.7, -0.1]
IST 07:00 | delta 0.05  | hold 12h | stop 2x | tp none || train $0.49/tr t=5.0 win 63% | test $0.23/tr t=1.3 win 52% | yrs+ 4/5 [0.7, 0.3, 0.4, 0.6, -0.1]
IST 05:00 | delta 0.05  | hold 12h | stop 2x | tp none || train $0.48/tr t=4.8 win 61% | test $0.10/tr t=0.5 win 53% | yrs+ 4/5 [0.6, 0.3, 0.4, 0.7, -0.2]
IST 05:00 | delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.47/tr t=4.8 win 61% | test $0.09/tr t=0.5 win 53% | yrs+ 4/5 [0.6, 0.3, 0.4, 0.7, -0.2]
IST 05:00 | delta 0.05  | hold 24h | stop 2x | tp 50% || train $0.50/tr t=4.6 win 56% | test $0.18/tr t=0.9 win 47% | yrs+ 4/5 [0.7, 0.3, 0.5, 0.8, -0.3]
IST 05:00 | delta 0.3   | hold 12h | stop 2x | tp 50% || train $2.18/tr t=4.5 win 72% | test -$1.25/tr t=-1.2 win 64% | yrs+ 4/5 [3.3, 1.5, 1.7, 2.9, -3.5]
IST 05:00 | delta 0.3   | hold 12h | stop 2x | tp none || train $2.17/tr t=4.5 win 72% | test -$1.25/tr t=-1.2 win 64% | yrs+ 4/5 [3.3, 1.4, 1.7, 2.9, -3.5]
IST 07:00 | delta 0.05  | hold 12h | stop 3x | tp 50% || train $0.58/tr t=4.4 win 79% | test -$0.02/tr t=-0.1 win 68% | yrs+ 4/5 [0.7, 0.4, 0.6, 0.8, -0.5]
IST 07:00 | delta 0.05  | hold 12h | stop 3x | tp none || train $0.58/tr t=4.4 win 78% | test -$0.07/tr t=-0.3 win 68% | yrs+ 4/5 [0.8, 0.4, 0.6, 0.7, -0.5]
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp none || train $1.88/tr t=4.3 win 79% | test -$0.65/tr t=-0.8 win 73% | yrs+ 4/5 [2.4, 1.2, 1.8, 2.0, -1.8]
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp 50% || train $1.87/tr t=4.3 win 79% | test -$0.65/tr t=-0.8 win 73% | yrs+ 4/5 [2.4, 1.2, 1.8, 2.0, -1.8]
IST 07:00 | delta 0.3   | hold 12h | stop 2x | tp 50% || train $2.05/tr t=4.2 win 73% | test -$1.25/tr t=-1.4 win 62% | yrs+ 4/5 [3.2, 1.4, 1.7, 2.3, -3.2]
IST 07:00 | delta 0.3   | hold 12h | stop 2x | tp none || train $2.05/tr t=4.2 win 73% | test -$1.25/tr t=-1.4 win 62% | yrs+ 4/5 [3.2, 1.4, 1.7, 2.3, -3.2]
IST 06:00 | delta 0.05  | hold 12h | stop 2x | tp none || train $0.43/tr t=4.2 win 61% | test $0.18/tr t=1.0 win 53% | yrs+ 4/5 [0.6, 0.3, 0.3, 0.6, -0.1]
IST 06:00 | delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.42/tr t=4.2 win 62% | test $0.18/tr t=1.0 win 53% | yrs+ 4/5 [0.5, 0.3, 0.3, 0.7, -0.1]

## Robust candidates (train>0, test>0, train t>=3, test t>=1.5, positive in >=4 of 5 years): 1
IST 07:00 | delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.50/tr t=5.1 win 64% | test $0.26/tr t=1.5 win 53% | yrs+ 4/5 [0.7, 0.3, 0.5, 0.7, -0.1]

## Best by entry hour (highest train mean among combos, with its test result)
00:00 IST  delta 0.1   | hold 24h | stop 2x | tp 50% || train $0.29/tr t=1.2 win 47% | test -$0.32/tr t=-0.7 win 42% | yrs+ 4/5 [0.1, 0.4, 0.3, 0.9, -1.1]
01:00 IST  delta 0.08  | hold 24h | stop 2x | tp 50% || train $0.35/tr t=1.9 win 50% | test $0.29/tr t=0.9 win 46% | yrs+ 4/5 [0.1, 0.2, 0.5, 0.9, -0.2]
02:00 IST  delta 0.15  | hold 24h | stop 2x | tp 50% || train $0.50/tr t=1.3 win 48% | test -$0.50/tr t=-0.8 win 39% | yrs+ 3/5 [1.0, 0.7, -0.0, 0.9, -1.6]
03:00 IST  delta 0.3   | hold 24h | stop 2x | tp none || train $1.38/tr t=1.8 win 49% | test -$1.56/tr t=-1.2 win 42% | yrs+ 3/5 [3.4, 1.0, -0.1, 3.1, -4.7]
04:00 IST  delta 0.05  | hold 24h | stop 2x | tp 50% || train $0.39/tr t=3.6 win 54% | test $0.17/tr t=0.8 win 47% | yrs+ 4/5 [0.5, 0.2, 0.4, 0.8, -0.2]
05:00 IST  delta 0.05  | hold 12h | stop 2x | tp none || train $0.48/tr t=4.8 win 61% | test $0.10/tr t=0.5 win 53% | yrs+ 4/5 [0.6, 0.3, 0.4, 0.7, -0.2]
06:00 IST  delta 0.2   | hold 12h | stop 3x | tp none || train $1.88/tr t=4.3 win 79% | test -$0.65/tr t=-0.8 win 73% | yrs+ 4/5 [2.4, 1.2, 1.8, 2.0, -1.8]
07:00 IST  delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.50/tr t=5.1 win 64% | test $0.26/tr t=1.5 win 53% | yrs+ 4/5 [0.7, 0.3, 0.5, 0.7, -0.1]
08:00 IST  delta 0.05  | hold 12h | stop 2x | tp 50% || train $0.35/tr t=3.6 win 61% | test $0.07/tr t=0.4 win 49% | yrs+ 4/5 [0.6, 0.3, 0.3, 0.4, -0.2]
09:00 IST  delta 0.05  | hold 24h | stop 2x | tp none || train $0.31/tr t=2.4 win 41% | test -$0.06/tr t=-0.3 win 33% | yrs+ 3/5 [0.6, 0.4, -0.1, 0.8, -0.7]
10:00 IST  delta 0.05  | hold  6h | stop 2x | tp none || train $0.20/tr t=2.8 win 73% | test -$0.06/tr t=-0.5 win 65% | yrs+ 4/5 [0.4, 0.1, 0.1, 0.4, -0.3]
11:00 IST  delta 0.05  | hold 24h | stop 2x | tp none || train $0.24/tr t=1.9 win 39% | test -$0.03/tr t=-0.2 win 31% | yrs+ 3/5 [0.4, 0.3, -0.0, 0.9, -0.7]
12:00 IST  delta 0.05  | hold  6h | stop 2x | tp none || train $0.10/tr t=1.5 win 69% | test -$0.05/tr t=-0.4 win 66% | yrs+ 3/5 [0.3, 0.1, -0.1, 0.3, -0.3]
13:00 IST  delta 0.05  | hold 24h | stop 2x | tp none || train $0.17/tr t=1.4 win 37% | test -$0.51/tr t=-2.4 win 28% | yrs+ 4/5 [0.3, 0.1, 0.1, 0.4, -1.0]
14:00 IST  delta 0.3   | hold 24h | stop 2x | tp none || train -$0.02/tr t=-0.0 win 40% | test -$3.95/tr t=-3.0 win 31% | yrs+ 2/5 [1.9, -0.3, -0.2, 0.4, -7.6]
15:00 IST  delta 0.25  | hold 24h | stop 2x | tp none || train -$0.03/tr t=-0.0 win 38% | test -$3.35/tr t=-3.1 win 29% | yrs+ 4/5 [0.6, 0.2, 0.0, 0.4, -6.3]
16:00 IST  delta 0.3   | hold 24h | stop 3x | tp none || train $0.76/tr t=0.7 win 65% | test -$3.33/tr t=-1.6 win 58% | yrs+ 3/5 [3.1, 1.6, -1.9, 2.8, -7.8]
17:00 IST  delta 0.3   | hold 24h | stop 3x | tp none || train -$0.02/tr t=-0.0 win 63% | test -$3.24/tr t=-1.5 win 59% | yrs+ 3/5 [2.8, 1.1, -2.1, 1.2, -7.7]
18:00 IST  delta 0.25  | hold 24h | stop 3x | tp none || train -$1.18/tr t=-1.2 win 67% | test -$3.78/tr t=-2.2 win 63% | yrs+ 2/5 [0.2, 0.2, -3.0, -1.1, -6.1]
19:00 IST  delta 0.3   | hold 24h | stop 3x | tp none || train -$1.43/tr t=-1.3 win 66% | test -$5.89/tr t=-2.8 win 64% | yrs+ 1/5 [-0.8, 0.4, -1.8, -3.2, -8.4]
20:00 IST  delta 0.25  | hold 24h | stop 3x | tp 50% || train -$0.75/tr t=-0.8 win 67% | test -$3.83/tr t=-2.3 win 62% | yrs+ 2/5 [0.3, 0.9, -0.8, -1.5, -7.2]
21:00 IST  delta 0.3   | hold 24h | stop none | tp none || train $0.21/tr t=0.1 win 74% | test -$3.69/tr t=-1.2 win 70% | yrs+ 3/5 [0.4, -0.2, 1.5, 1.5, -7.9]
22:00 IST  delta 0.3   | hold 24h | stop none | tp none || train $0.10/tr t=0.1 win 74% | test -$3.73/tr t=-1.4 win 69% | yrs+ 2/5 [0.7, -0.8, 2.1, -0.8, -6.4]
23:00 IST  delta 0.1   | hold 24h | stop 3x | tp 50% || train $0.24/tr t=0.7 win 68% | test $0.09/tr t=0.1 win 64% | yrs+ 3/5 [0.5, 0.6, -0.1, 0.5, -0.6]

## Average over all combos, by delta / hold / stop / tp (train | test mean per trade)
-- delta
0.05       train -$0.65 | test -$1.02 | stop rate 22%
0.08       train -$0.96 | test -$1.55 | stop rate 20%
0.1        train -$1.17 | test -$1.96 | stop rate 20%
0.125      train -$1.42 | test -$2.41 | stop rate 19%
0.15       train -$1.63 | test -$2.90 | stop rate 18%
0.2        train -$1.83 | test -$3.66 | stop rate 17%
0.25       train -$1.92 | test -$4.03 | stop rate 16%
0.3        train -$2.00 | test -$4.13 | stop rate 14%
-- hold
3h         train -$1.86 | test -$2.83 | stop rate 7%
6h         train -$1.71 | test -$2.85 | stop rate 13%
12h        train -$1.36 | test -$2.71 | stop rate 22%
24h        train -$0.85 | test -$2.43 | stop rate 31%
-- stop
none       train -$1.96 | test -$3.06 | stop rate 0%
2x         train -$1.06 | test -$2.31 | stop rate 36%
3x         train -$1.32 | test -$2.75 | stop rate 18%
-- take profit
none       train -$1.43 | test -$2.69 | stop rate 18%
50%        train -$1.47 | test -$2.72 | stop rate 18%

## Re-check on the last 13 months with the REAL archived N2N IV instead of DVOL x k (robust candidates)
IST 07:00 | delta 0.05  | hold 12h | stop 2x | tp 50% || real-IV 361 days: -$1.46/trade (total -$528, win 39%, t=-5.6)

## Detail: IST 07:00 | delta 0.05  | hold 12h | stop 2x | tp 50%
Train: n=1070 mean $0.50 total $538 win 64% stop 36% maxDD $63
Test:  n=464 mean $0.26 total $122 win 53% stop 47% maxDD $76
Avg portfolio margin per trade $59; mean/trade as % of margin: train 0.85%, test 0.44%
By weekday (IST entry date): Sun $1.38 | Mon -$0.62 | Tue -$0.11 | Wed $0.02 | Thu $0.07 | Fri $0.26 | Sat $2.01
By year (mean/trade): 2021-22 $0.71 | 2022-23 $0.33 | 2023-24 $0.49 | 2024-25 $0.69 | 2025-26 -$0.06
