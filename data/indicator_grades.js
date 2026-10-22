/* Indicator grades from the 5-year backtests (14 studies). grade: primary | watch | veto | off.
   primary = strong 5-yr stop predictor (verify entry with it); watch = moderate/confirming;
   veto = only acts at extremes; off = live-only or not 5-yr backtestable (told honestly, not faked). */
window.__STRANGLE_INDICATORS = {
  updated: "2026-10-21",
  basis: "5-year DVOL + BS-modelled legs (1-year real option IV) · stop@2× unless noted",
  legend: {
    primary: "Strong 5-yr predictor — verify the entry with it",
    watch: "Moderate / confirming — colours the read, doesn't gate",
    veto: "Only acts at extremes (block / pick a leg)",
    off: "Live-only or no 5-yr data — can't backtest, shown honestly"
  },
  items: [
    { id: "spd",   name: "Speed vs IV",          grade: "primary", stat: "22% → 59%", note: "RV÷IV < 1.0 = calm. The #1 entry verifier." },
    { id: "rng",   name: "Range 24H",            grade: "primary", stat: "20% → 61%", note: "<1× implied = quiet. Your '1–2× good' should read '<1 good'." },
    { id: "rv",    name: "Realised vol (6h)",    grade: "primary", stat: "18% → 56%", note: "RV6 < 50 safe, ≥100 danger. 6h-over-24h only matters ≥1.6." },
    { id: "vov",   name: "Vol of vol",           grade: "primary", stat: "13% → 33%", note: "Low VoV = stable regime = the safest green light." },
    { id: "dv",    name: "DVOL",                 grade: "primary", stat: "19% → 57%", note: "Gently falling = crush (good); spiking = danger. Low regime safer." },
    { id: "vwap",  name: "VWAP ± bands",         grade: "primary", stat: "20% → 67%", note: "Near VWAP (fair value) safe; stretched >2% = danger." },
    { id: "avp",   name: "Anchored VWAP+vol",    grade: "primary", stat: "20% → 67%", note: "Same family as VWAP distance — sell near value." },
    { id: "crush", name: "IV driver · crush",    grade: "primary", stat: "core",      note: "Sell the IV turn (DVOL gently falling) — validated 5 yr." },
    { id: "sig",   name: "Entry signal (IV turn)", grade: "primary", stat: "trigger", note: "The entry trigger itself: peak then turn-down." },
    { id: "gng",   name: "Go / No-Go",           grade: "primary", stat: "gate",      note: "The composite gate of the primaries." },

    { id: "edge",  name: "Edge (IV − RV)",       grade: "watch", stat: "confirm", note: "Edge-rich helps; not strong standalone." },
    { id: "iv",    name: "ATM IV level",         grade: "watch", stat: "4% → 33% by band", note: "Lower IV safer at 2×; use the band-adaptive stop." },
    { id: "term",  name: "Term spread",          grade: "watch", stat: "18% → 42% (1yr)", note: "Prefer contango (front ≤ N2N). 1-year evidence only." },
    { id: "ton",   name: "IV vs 17:30 clock",    grade: "watch", stat: "23% → 42%", note: "MODERATELY below clock = good; a hard crash below is also risky." },
    { id: "day",   name: "Day of week",          grade: "watch", stat: "context", note: "Fri/Tue safe · Wed/Mon risky · Sun off." },
    { id: "ses",   name: "Session / month",      grade: "watch", stat: "context", note: "Sep–Oct calm · Jan–Mar/Jun/Nov wild." },
    { id: "pwin",  name: "P(success)",           grade: "watch", note: "Composite probability — informative." },
    { id: "ready", name: "Entry · Hold · Exit",  grade: "watch", note: "Timing state engine." },
    { id: "legs",  name: "Leg multiple",         grade: "watch", note: "Intratrade stop defense while open." },
    { id: "strk",  name: "Strikes / exp move",   grade: "watch", note: "Position / breakeven context." },
    { id: "liq",   name: "Liquidations",         grade: "watch", stat: "cascade", note: "The cascade IS the stop (13% vs 74%); the live feed is the warning." },
    { id: "lhm",   name: "Liquidation heatmap",  grade: "watch", stat: "cascade", note: "Cascade proxy; real per-level feed is live-only (not 5-yr backtestable)." },
    { id: "tip",   name: "Improve my trades",    grade: "watch", note: "Your trades vs the tested rule." },

    { id: "adx",   name: "ADX 14",               grade: "veto", stat: "only ≥40 (42%)", note: "Veto a raging trend. 'ADX falling' = noise (27.8 vs 27.1%)." },
    { id: "rsi",   name: "RSI 14",               grade: "veto", stat: "extremes 42–65%", note: "<30 / >70 only; tells which leg to defend. RSI>60 skip = debunked." },

    { id: "gex",   name: "Dealer gamma",         grade: "off", note: "Live-only; no 5-yr GEX data." },
    { id: "skew",  name: "25Δ skew",             grade: "off", note: "No 5-yr multi-strike IV." },
    { id: "fund",  name: "Funding + OI",         grade: "off", note: "OI history is live-only (~30d)." },
    { id: "dfl",   name: "Deribit option flow",  grade: "off", note: "Live-only flow." },
    { id: "grk",   name: "ATM Greeks",           grade: "off", note: "Derived; no standalone edge." },
    { id: "spr",   name: "Bid / ask spread",     grade: "off", note: "Live execution quality only." },
    { id: "fp",    name: "Footprint",            grade: "off", note: "Live microstructure; no 5-yr." },
    { id: "fut",   name: "Futures positioning",  grade: "off", note: "OI history live-only (~30d)." },
    { id: "pat",   name: "Chart patterns",       grade: "off", note: "Not backtested." },
    { id: "cdl",   name: "Candle patterns",      grade: "off", note: "Not backtested." }
  ]
};
