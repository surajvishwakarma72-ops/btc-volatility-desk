window.__STRANGLE_RULEBOOK = {
  "generatedFrom": "2025-10-06..2026-10-17 (327 nights, Binance 15m/1m + archive IV, BS-repriced)",
  "dataCaveats": [
    "Legs BS-repriced from ATM IV (no historical option prices/bid-ask).",
    "bid-ask>1.5% reject is live-only (not modeled).",
    "News blackout: no event calendar in data — high-SL months used as a proxy.",
    "vol-of-vol/skew/GEX/flow are sparse/low-fidelity and did not survive OOS."
  ],
  "global": {
    "entry_window": "Sell the IV turn, 22:30–23:30 IST (Friday ~23:00). NEVER sell into the 21:30 London-close spike — wait for it to exhaust. Late entry is the #1 stop-loss lever.",
    "iv_conditions": [
      "Trade every IV band 25–60. 45–60 is the richest 'sweet' zone; 35–45 is the lowest-edge dead-zone but still traded full size.",
      "The ONLY sit-out is IV >= 65% (panic)."
    ],
    "silence_conditions": [
      "Primary \"silence\" = the clock (late entry, after the London-close move exhausts)."
    ],
    "veto_conditions": [
      "NONE. No RSI veto, no skipping. Trade every weekday, full 100 lots. Only emergency sit-out: IV >= 65% panic or a red high-impact event."
    ],
    "delay_rules": [
      "Reduce stops by TIMING (enter after the London-close spike / on the IV turn), never by skipping a night or widening the stop."
    ],
    "leg_sizing": "Symmetric 0.15Δ both legs, full 100 lots every weekday. No half-size, no asymmetric skew.",
    "early_exit_rules": [
      "Strict 2.0× per-leg stop — never wider. 12% profit target or hard 07:00 IST exit."
    ],
    "news_blackout": [
      "Data-limited (no calendar). Respect February (wildest month) and Week-1 (wildest week) — still trade, just wait for the turn."
    ],
    "week_of_month": "Week 1 is the most volatile (London close ~57% RV); weeks 4–5 calmest. Trade all — the only lever is entry timing.",
    "position": "100 lots, 0.15Δ N2N strangle, margin ~$87, target net >=12% margin (~$10.4), strict 2× stop, hard exit 07:00 IST."
  },
  "weekdays": [
    {
      "weekday": "Mon",
      "verdict": "TRADE",
      "oosWinPct": 73.3,
      "expectancyUsd": 1.23,
      "sampleSize": 36,
      "fragile": false,
      "conviction": "NORMAL",
      "earliest_entry": "22:30 IST",
      "latest_entry": "01:00 IST"
    },
    {
      "weekday": "Tue",
      "verdict": "TRADE",
      "oosWinPct": 68,
      "expectancyUsd": 0.78,
      "sampleSize": 41,
      "fragile": false,
      "conviction": "NORMAL",
      "earliest_entry": "22:30 IST",
      "latest_entry": "01:00 IST"
    },
    {
      "weekday": "Wed",
      "verdict": "TRADE",
      "oosWinPct": 63.6,
      "expectancyUsd": 1.39,
      "sampleSize": 44,
      "fragile": false,
      "conviction": "NORMAL",
      "earliest_entry": "22:30 IST",
      "latest_entry": "01:00 IST"
    },
    {
      "weekday": "Thu",
      "verdict": "TRADE",
      "oosWinPct": 61.6,
      "expectancyUsd": 1.5,
      "sampleSize": 39,
      "fragile": false,
      "conviction": "NORMAL",
      "earliest_entry": "22:30 IST",
      "latest_entry": "01:00 IST"
    },
    {
      "weekday": "Fri",
      "verdict": "TRADE",
      "oosWinPct": 75,
      "expectancyUsd": 3.48,
      "sampleSize": 44,
      "fragile": false,
      "conviction": "HIGH",
      "earliest_entry": "22:30 IST",
      "latest_entry": "01:30 IST"
    }
  ],
  "evidence": {
    "blindBaselineBestPerWeekday": {
      "Sun": {
        "bestByExpectancy": {
          "entryIST": "21:00",
          "avgPnlUsd": -5.43,
          "slRate": 52.5,
          "winRate": 27.5,
          "n": 40
        },
        "leastStopLoss": {
          "entryIST": "23:30",
          "slRate": 50,
          "avgPnlUsd": -5.48,
          "n": 40
        }
      },
      "Mon": {
        "bestByExpectancy": {
          "entryIST": "22:00",
          "avgPnlUsd": 0.77,
          "slRate": 27.7,
          "winRate": 63.8,
          "n": 47
        },
        "leastStopLoss": {
          "entryIST": "22:45",
          "slRate": 23.4,
          "avgPnlUsd": -0.19,
          "n": 47
        }
      },
      "Tue": {
        "bestByExpectancy": {
          "entryIST": "21:00",
          "avgPnlUsd": 0.93,
          "slRate": 24.1,
          "winRate": 64.8,
          "n": 54
        },
        "leastStopLoss": {
          "entryIST": "01:30",
          "slRate": 16.7,
          "avgPnlUsd": -0.89,
          "n": 54
        }
      },
      "Wed": {
        "bestByExpectancy": {
          "entryIST": "20:45",
          "avgPnlUsd": 1.87,
          "slRate": 31.1,
          "winRate": 64.4,
          "n": 45
        },
        "leastStopLoss": {
          "entryIST": "01:15",
          "slRate": 13.3,
          "avgPnlUsd": 0.04,
          "n": 45
        }
      },
      "Thu": {
        "bestByExpectancy": {
          "entryIST": "23:15",
          "avgPnlUsd": 2.1,
          "slRate": 20,
          "winRate": 62.2,
          "n": 45
        },
        "leastStopLoss": {
          "entryIST": "01:30",
          "slRate": 13.3,
          "avgPnlUsd": -0.34,
          "n": 45
        }
      },
      "Fri": {
        "bestByExpectancy": {
          "entryIST": "23:00",
          "avgPnlUsd": 3.14,
          "slRate": 21.3,
          "winRate": 78.7,
          "n": 47
        },
        "leastStopLoss": {
          "entryIST": "01:00",
          "slRate": 10.6,
          "avgPnlUsd": 2.19,
          "n": 47
        }
      },
      "Sat": {
        "bestByExpectancy": {
          "entryIST": "23:45",
          "avgPnlUsd": -2.91,
          "slRate": 14.3,
          "winRate": 30.6,
          "n": 49
        },
        "leastStopLoss": {
          "entryIST": "23:15",
          "slRate": 12.2,
          "avgPnlUsd": -3.08,
          "n": 49
        }
      }
    },
    "ivCrushCensus": {
      "crush": 178,
      "rebound": 29,
      "noEvent": 63
    },
    "scorecardKept": [
      "rsi15"
    ],
    "vetoKept": [
      "rsi15 > 60"
    ]
  }
};
