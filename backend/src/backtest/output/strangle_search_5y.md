# Five-year short strangle search
Data: Binance 15m 2021-10-20 to 2026-10-24, DVOL x 0.881 as flat IV (calibrated on 313 days of real N2N ATM IV; monthly ratios 2025-10 0.88, 2025-11 0.92, 2025-12 0.84, 2026-01 0.91, 2026-02 0.99, 2026-03 0.96, 2026-04 0.91, 2026-05 0.82, 2026-06 0.93, 2026-07 0.88, 2026-08 0.83, 2026-09 0.87, 2026-10 0.81).
Grid: 24 entry hours (IST) x 8 deltas x 4 holds x 3 stops x 2 take-profits = 4608 combos, each traded every day, 100 lots/leg, N2N expiry. Train 2021-11-02 to 2025-04-25, test after.
Costs: 1.2% half-spread (min $1) each way, Delta option fee + GST. No gate, no skew, flat IV.

## Is profit widespread?
Combos with a positive average in TRAIN: 227/4608 (4.9%). Positive in BOTH train and test: 0 (0.0%).
Train t-stat of at least 4.1 (the bar for 4608 tests): 0. Of those, still positive in test: 0; with test t >= 2: 0.
Median combo: train -$1.79/trade, test -$3.11/trade.

## Top 15 by TRAIN t-stat (what the search would have picked), with their TEST result
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp none || train $1.04/tr t=2.4 win 77% | test -$1.84/tr t=-2.1 win 70% | yrs+ 4/5 [1.6, 0.8, 1.0, 0.5, -2.9]
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp 50% || train $1.03/tr t=2.4 win 77% | test -$1.84/tr t=-2.1 win 70% | yrs+ 4/5 [1.6, 0.8, 1.0, 0.5, -2.9]
IST 06:00 | delta 0.1   | hold 12h | stop 3x | tp 50% || train $0.57/tr t=2.3 win 77% | test -$0.40/tr t=-0.8 win 70% | yrs+ 4/5 [1.1, 0.3, 0.7, 0.6, -1.2]
IST 06:00 | delta 0.1   | hold 12h | stop 3x | tp none || train $0.57/tr t=2.3 win 77% | test -$0.40/tr t=-0.8 win 70% | yrs+ 4/5 [1.1, 0.3, 0.7, 0.6, -1.2]
IST 06:00 | delta 0.08  | hold 12h | stop 3x | tp none || train $0.43/tr t=2.1 win 76% | test -$0.16/tr t=-0.4 win 71% | yrs+ 4/5 [0.9, 0.1, 0.4, 0.9, -0.9]
IST 06:00 | delta 0.08  | hold 12h | stop 3x | tp 50% || train $0.42/tr t=2.0 win 76% | test -$0.15/tr t=-0.4 win 71% | yrs+ 4/5 [0.9, 0.1, 0.4, 0.9, -0.9]
IST 05:00 | delta 0.2   | hold 24h | stop 2x | tp none || train $1.01/tr t=2.0 win 47% | test -$1.18/tr t=-1.3 win 38% | yrs+ 4/5 [2.6, 1.0, 0.2, 1.9, -3.8]
IST 06:00 | delta 0.125 | hold 12h | stop 3x | tp none || train $0.60/tr t=2.0 win 76% | test -$0.62/tr t=-1.1 win 71% | yrs+ 4/5 [1.3, 0.4, 0.5, 0.3, -1.4]
IST 06:00 | delta 0.125 | hold 12h | stop 3x | tp 50% || train $0.60/tr t=2.0 win 76% | test -$0.62/tr t=-1.1 win 71% | yrs+ 4/5 [1.3, 0.4, 0.5, 0.3, -1.4]
IST 06:00 | delta 0.15  | hold 12h | stop 3x | tp 50% || train $0.66/tr t=1.9 win 76% | test -$0.99/tr t=-1.5 win 70% | yrs+ 4/5 [1.4, 0.6, 0.6, 0.3, -1.9]
IST 06:00 | delta 0.15  | hold 12h | stop 3x | tp none || train $0.66/tr t=1.9 win 76% | test -$0.99/tr t=-1.5 win 70% | yrs+ 4/5 [1.4, 0.6, 0.6, 0.3, -1.9]
IST 07:00 | delta 0.2   | hold 12h | stop 2x | tp none || train $0.63/tr t=1.8 win 69% | test -$1.93/tr t=-3.0 win 56% | yrs+ 3/5 [1.6, 0.7, 0.1, -0.3, -2.7]
IST 07:00 | delta 0.2   | hold 12h | stop 2x | tp 50% || train $0.62/tr t=1.8 win 69% | test -$1.93/tr t=-3.0 win 56% | yrs+ 3/5 [1.6, 0.7, 0.1, -0.3, -2.7]
IST 07:00 | delta 0.05  | hold 12h | stop 3x | tp 50% || train $0.23/tr t=1.8 win 76% | test -$0.45/tr t=-1.8 win 66% | yrs+ 4/5 [0.4, 0.1, 0.2, 0.4, -0.9]
IST 05:00 | delta 0.3   | hold 12h | stop 2x | tp 50% || train $0.85/tr t=1.8 win 71% | test -$2.97/tr t=-2.9 win 63% | yrs+ 4/5 [2.0, 0.9, 0.2, 0.6, -5.2]

## Robust candidates (train>0, test>0, train t>=3, test t>=1.5, positive in >=4 of 5 years): 0

## Best by entry hour (highest train mean among combos, with its test result)
00:00 IST  delta 0.15  | hold 24h | stop 3x | tp 50% || train -$0.34/tr t=-0.6 win 66% | test -$2.09/tr t=-2.1 win 60% | yrs+ 3/5 [0.1, 0.2, 0.0, -1.0, -3.5]
01:00 IST  delta 0.08  | hold 24h | stop 3x | tp 50% || train -$0.01/tr t=-0.0 win 68% | test -$0.80/tr t=-1.6 win 62% | yrs+ 3/5 [-0.1, 0.0, 0.1, 0.0, -1.3]
02:00 IST  delta 0.125 | hold 24h | stop 3x | tp 50% || train -$0.09/tr t=-0.2 win 67% | test -$2.71/tr t=-3.2 win 58% | yrs+ 2/5 [0.8, 0.2, -0.3, -1.5, -3.6]
03:00 IST  delta 0.08  | hold 24h | stop 3x | tp 50% || train -$0.04/tr t=-0.1 win 69% | test -$1.00/tr t=-2.0 win 61% | yrs+ 2/5 [0.5, -0.2, 0.2, -0.4, -1.7]
04:00 IST  delta 0.125 | hold 24h | stop 2x | tp 50% || train $0.35/tr t=1.2 win 48% | test -$1.26/tr t=-2.3 win 39% | yrs+ 3/5 [1.4, 0.1, -0.5, 0.8, -2.4]
05:00 IST  delta 0.2   | hold 24h | stop 2x | tp none || train $1.01/tr t=2.0 win 47% | test -$1.18/tr t=-1.3 win 38% | yrs+ 4/5 [2.6, 1.0, 0.2, 1.9, -3.8]
06:00 IST  delta 0.2   | hold 12h | stop 3x | tp none || train $1.04/tr t=2.4 win 77% | test -$1.84/tr t=-2.1 win 70% | yrs+ 4/5 [1.6, 0.8, 1.0, 0.5, -2.9]
07:00 IST  delta 0.2   | hold 12h | stop 2x | tp none || train $0.63/tr t=1.8 win 69% | test -$1.93/tr t=-3.0 win 56% | yrs+ 3/5 [1.6, 0.7, 0.1, -0.3, -2.7]
08:00 IST  delta 0.25  | hold 12h | stop none | tp none || train $0.42/tr t=0.7 win 75% | test -$2.71/tr t=-2.1 win 67% | yrs+ 3/5 [1.3, 0.5, -1.1, 1.8, -5.0]
09:00 IST  delta 0.1   | hold 24h | stop 2x | tp none || train $0.04/tr t=0.2 win 39% | test -$0.78/tr t=-1.7 win 31% | yrs+ 3/5 [0.7, 0.4, -0.7, 0.8, -2.2]
10:00 IST  delta 0.25  | hold 24h | stop 2x | tp none || train -$0.19/tr t=-0.3 win 40% | test -$2.52/tr t=-2.3 win 33% | yrs+ 3/5 [1.3, 0.5, -1.4, 0.9, -5.6]
11:00 IST  delta 0.25  | hold 24h | stop 2x | tp none || train $0.05/tr t=0.1 win 40% | test -$3.12/tr t=-2.9 win 33% | yrs+ 3/5 [1.2, 0.4, -1.3, 1.2, -5.9]
12:00 IST  delta 0.25  | hold 24h | stop 2x | tp none || train -$0.60/tr t=-1.0 win 39% | test -$3.22/tr t=-2.9 win 33% | yrs+ 1/5 [-0.2, -0.1, -1.4, 1.5, -6.7]
13:00 IST  delta 0.25  | hold 24h | stop 3x | tp none || train -$0.80/tr t=-0.8 win 62% | test -$4.61/tr t=-2.5 win 59% | yrs+ 1/5 [1.2, -0.1, -2.4, -0.3, -8.0]
14:00 IST  delta 0.25  | hold 24h | stop 3x | tp none || train -$1.03/tr t=-1.1 win 62% | test -$3.59/tr t=-2.0 win 59% | yrs+ 2/5 [1.8, 0.0, -2.4, -0.6, -7.7]
15:00 IST  delta 0.3   | hold 24h | stop none | tp none || train -$2.81/tr t=-1.4 win 73% | test -$3.74/tr t=-1.0 win 72% | yrs+ 0/5 [-1.9, -0.2, -2.7, -0.6, -10.0]
16:00 IST  delta 0.3   | hold 24h | stop 3x | tp none || train -$0.54/tr t=-0.5 win 64% | test -$5.40/tr t=-2.6 win 57% | yrs+ 3/5 [2.0, 1.0, -3.4, 0.3, -9.7]
17:00 IST  delta 0.3   | hold 24h | stop 3x | tp none || train -$1.03/tr t=-0.9 win 62% | test -$5.00/tr t=-2.4 win 58% | yrs+ 2/5 [1.6, 0.5, -3.2, -0.7, -9.1]
18:00 IST  delta 0.3   | hold 24h | stop none | tp none || train -$4.36/tr t=-2.2 win 73% | test -$4.68/tr t=-1.4 win 71% | yrs+ 0/5 [-4.5, -0.9, -4.7, -1.7, -10.4]
19:00 IST  delta 0.3   | hold 24h | stop none | tp none || train -$4.08/tr t=-2.1 win 71% | test -$4.38/tr t=-1.4 win 68% | yrs+ 0/5 [-4.1, -2.1, -2.9, -1.4, -10.1]
20:00 IST  delta 0.3   | hold 24h | stop none | tp 50% || train -$2.93/tr t=-1.7 win 72% | test -$5.02/tr t=-1.7 win 66% | yrs+ 0/5 [-3.3, -1.2, -1.6, -1.2, -10.4]
21:00 IST  delta 0.3   | hold 24h | stop none | tp none || train -$1.26/tr t=-0.8 win 73% | test -$5.64/tr t=-1.9 win 69% | yrs+ 0/5 [-1.1, -0.8, -0.2, -1.0, -9.7]
22:00 IST  delta 0.3   | hold 24h | stop none | tp none || train -$1.35/tr t=-0.9 win 72% | test -$5.66/tr t=-2.1 win 68% | yrs+ 1/5 [-0.7, -1.4, 0.4, -3.3, -8.2]
23:00 IST  delta 0.125 | hold 24h | stop 3x | tp 50% || train -$0.24/tr t=-0.5 win 66% | test -$0.76/tr t=-1.0 win 61% | yrs+ 2/5 [0.4, 0.3, -0.9, -0.1, -1.6]

## Average over all combos, by delta / hold / stop / tp (train | test mean per trade)
-- delta
0.05       train -$1.02 | test -$1.40 | stop rate 23%
0.08       train -$1.37 | test -$1.97 | stop rate 21%
0.1        train -$1.61 | test -$2.44 | stop rate 20%
0.125      train -$1.93 | test -$3.00 | stop rate 19%
0.15       train -$2.22 | test -$3.63 | stop rate 19%
0.2        train -$2.65 | test -$4.68 | stop rate 17%
0.25       train -$2.98 | test -$5.42 | stop rate 16%
0.3        train -$3.35 | test -$5.91 | stop rate 15%
-- hold
3h         train -$2.55 | test -$3.68 | stop rate 7%
6h         train -$2.40 | test -$3.70 | stop rate 14%
12h        train -$2.06 | test -$3.56 | stop rate 23%
24h        train -$1.56 | test -$3.29 | stop rate 32%
-- stop
none       train -$2.67 | test -$3.92 | stop rate 0%
2x         train -$1.74 | test -$3.15 | stop rate 37%
3x         train -$2.02 | test -$3.59 | stop rate 19%
-- take profit
none       train -$2.12 | test -$3.54 | stop rate 19%
50%        train -$2.16 | test -$3.57 | stop rate 19%

## Re-check on the last 13 months with the REAL archived N2N IV instead of DVOL x k (no robust candidates, so the top train picks)
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp none || real-IV 360 days: -$6.71/trade (total -$2416, win 51%, t=-5.6)
IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp 50% || real-IV 360 days: -$6.51/trade (total -$2343, win 51%, t=-5.4)
IST 06:00 | delta 0.1   | hold 12h | stop 3x | tp 50% || real-IV 360 days: -$2.95/trade (total -$1062, win 54%, t=-4.8)
IST 06:00 | delta 0.1   | hold 12h | stop 3x | tp none || real-IV 360 days: -$3.17/trade (total -$1143, win 53%, t=-5.2)
IST 06:00 | delta 0.08  | hold 12h | stop 3x | tp none || real-IV 360 days: -$2.93/trade (total -$1056, win 52%, t=-5.6)
IST 06:00 | delta 0.08  | hold 12h | stop 3x | tp 50% || real-IV 360 days: -$2.72/trade (total -$980, win 54%, t=-5.2)
IST 05:00 | delta 0.2   | hold 24h | stop 2x | tp none || real-IV 357 days: -$8.71/trade (total -$3108, win 22%, t=-8.3)
IST 06:00 | delta 0.125 | hold 12h | stop 3x | tp none || real-IV 360 days: -$4.38/trade (total -$1575, win 52%, t=-5.7)

## Detail: IST 06:00 | delta 0.2   | hold 12h | stop 3x | tp none
Train: n=1070 mean $1.04 total $1108 win 77% stop 12% maxDD $434
Test:  n=464 mean -$1.84 total -$854 win 70% stop 17% maxDD $1149
Avg portfolio margin per trade $59; mean/trade as % of margin: train 1.75%, test -3.11%
By weekday (IST entry date): Sun $3.60 | Mon -$3.84 | Tue -$1.79 | Wed $0.29 | Thu -$0.66 | Fri -$1.34 | Sat $4.90
By year (mean/trade): 2021-22 $1.57 | 2022-23 $0.80 | 2023-24 $0.97 | 2024-25 $0.49 | 2025-26 -$2.92
