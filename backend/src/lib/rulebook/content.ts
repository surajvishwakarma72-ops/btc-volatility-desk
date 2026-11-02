/**
 * Rule Book text (section 8 of news_alert_build_prompt.md). Plain data: edit the words here; the numbers the checklist
 * enforces live in config.ts. The panel renders every section; nothing here is code.
 */

export interface Section {
  id: string;
  title: string;
  /** Short paragraphs. */
  text?: string[];
  /** Numbered or bulleted lines. */
  list?: string[];
  ordered?: boolean;
  /** Simple two-or-more column table. */
  table?: { head: string[]; rows: string[][] };
}

export const RULEBOOK: { note: string; sections: Section[] } = {
  note: 'No rule set is foolproof or guarantees profit. Patterns are tendencies; verify them with the terminal’s own history.',
  sections: [
    {
      id: 'why',
      title: 'Why the strategy works',
      text: [
        'A short strangle earns because options usually price more movement than BTC delivers (implied volatility above realised volatility most of the time).',
        'Sellers lose the rest of the time and in rare shocks, so these rules are about staying out then, sizing small, and exiting by rule.',
      ],
    },
    {
      id: 'first5',
      title: 'First 5 minutes: open panels in this order',
      text: ['Stop at any failure: no trade.'],
      ordered: true,
      list: [
        'System / Key Health: all feeds and keys green and fresh.',
        'News and events: no CRITICAL/HIGH recently; no CPI/NFP/FOMC in the next 60 min.',
        'Regime gate: IV/RV > 1.3, ADX < 15, no killer pattern, DVOL not spiking.',
        'Strangle Pulse: SELL NOW / Sell zone only.',
        'IV vs Clock and session IV fall: room left for IV to fall this session.',
        'Elevated IV tracker: if IV is holding, which session usually crushes it.',
        'BTC chart with GEX and max pain: strikes vs gamma walls and big OI.',
        'GoGo zone indicator: zone path and HOLD/EXIT.',
        'Strike Picker: 0.10–0.15 delta, spreads, credit.',
        'Ask-me: place the order; wait for the confirmed tick.',
      ],
    },
    {
      id: 'hard',
      title: 'Hard rules',
      ordered: true,
      list: [
        'Strikes only between 0.10 and 0.15 delta (live, paper, algo).',
        'Sell the N2N expiry; skip the two nearest.',
        'No entry without both gates: regime gate and Strangle Pulse SELL NOW.',
        'No entry on NO DATA, red Key Health or a stale feed.',
        'No entry within 60 min before CPI/NFP/FOMC, nor for hours after a CRITICAL/HIGH alert.',
        'Exit at 1:1: close when the loss equals the profit target; never move the exit further away.',
        'Never add to a losing short or average a tested leg.',
        'Keep the 20% safety buffer (SAFETY_BUFFER_PCT = 0.20) untouched.',
        'Risk per trade at most 1–2% of equity at the exit level; half on weekends and event weeks.',
        'Spread veto: no entry if either leg’s spread is more than 10% of its premium.',
        'Daily stop: after 2 rule exits or a 3% equity loss in a day.',
        'CRITICAL news while in a trade: close first, then read.',
        'Journal every trade within the hour.',
        'Rule broken: half size for the next 5 trades.',
      ],
    },
    {
      id: 'checklist',
      title: 'Before-entry checklist (computed live)',
      list: [
        'Key Health green', 'No CRITICAL/HIGH news', 'No top-tier release within 60 min', 'IV/RV > 1.3', 'ADX < 15', 'No killer pattern',
        'Strangle Pulse SELL NOW', 'Room left in session IV fall', 'Term structure not inverted, no IV kink on the chosen expiry',
        'Both strikes 0.10–0.15 delta and beyond the nearest big gamma wall', 'Spreads < 10%', 'Size within 1–2% risk, 20% buffer intact',
        'Exit levels in BTC price shown for both sides',
      ],
    },
    {
      id: 'intrade',
      title: 'In-trade checks (every 15 min) and exit table',
      text: ['Watch: floating P&L vs peak and drawdown · Strangle Pulse zone and GoGo · leg balance (tested leg delta > 0.30 = warning) · delta jumping on small moves · IV trend (rising IV with rising RV) · OI on your strikes · news and spreads.'],
      table: {
        head: ['Signal', 'Action'],
        rows: [
          ['Loss reaches the 1:1 exit level', 'Close both legs'],
          ['CRITICAL news popup', 'Close both legs'],
          ['Killer pattern forms', 'Close both legs'],
          ['Zone → Avoid, or GoGo EXIT', 'Close, or halve if still profitable'],
          ['Tested leg delta > 0.30', 'Close the tested leg; keep the other only if the zone is still Sell'],
          ['Most premium collected', 'Take profit'],
          ['Top-tier release approaching while in profit', 'Take profit or halve'],
          ['Spreads > 10%', 'Reduce while exits are still fair'],
        ],
      },
    },
    {
      id: 'sizing',
      title: 'Sizing, margin, liquidation',
      list: [
        'Lots = (Equity × Risk per trade) ÷ (Loss per lot at the exit level, fees and slippage included). Round down; under 1 lot means the trade is too big.',
        'Margin rises as BTC nears your strikes and as IV rises; keep the 20% buffer; margin alerts at 70% and 85% used.',
        'The 1:1 exit must always trigger well before liquidation; if not, the size is wrong.',
        'Algo and manual trades on one account are sized together.',
      ],
      table: {
        head: ['Situation', 'Risk per trade'],
        rows: [
          ['Normal weekday, all gates green', '1–2%'],
          ['Weekend, or a top-tier release this week', '0.5–1%'],
          ['After a rule break (next 5 trades)', 'Half of normal'],
          ['Readiness LIMITED / data doubtful', 'No trade'],
        ],
      },
    },
    {
      id: 'routine',
      title: 'Daily routine',
      ordered: true,
      list: [
        'Start of day: Key Health, last 12 h of news, this week’s release and expiry calendar.',
        'Before entry: the full checklist.',
        'In a trade: the 15-minute checks.',
        'After exit: the journal.',
        'Weekly review: win rate, average win vs loss, rule breaks, gates followed vs overridden.',
      ],
    },
    {
      id: 'sessions',
      title: 'Sessions (IST; the Tonight tab shows today’s exact times, daylight saving included)',
      table: {
        head: ['Session', 'Winter IST', 'Behaviour', 'Approach'],
        rows: [
          ['Asia', '05:30–13:30', 'Moderate, often range-bound', 'Good for decay; thinner premium'],
          ['Quiet hours', '~11:30–13:30', 'Least active', 'Hold; poor fills for entry'],
          ['London', '13:30–22:30', 'Liquidity rises, directional moves start', 'Don’t enter into the London open'],
          ['London + NY overlap', '19:30–22:30', 'Highest volume and volatility', 'US data at 19:00; never enter just before'],
          ['New York', '19:30–04:30', 'Institutional, macro-driven', 'Your entry: ~23:00 after the NY open settles (~22:00 in US summer)'],
          ['Late US', '01:30–05:30', 'Thin, wide spreads', 'Hold, don’t enter; FOMC ~00:30'],
        ],
      },
      text: ['Fixed: Delta settlement 17:30 IST daily · Deribit 13:30 IST on Fridays. US data 19:00 IST in winter, 18:00 in US summer; the NY open 20:00 → 19:00. In the two transition weeks (US moved, UK not) the terminal shows a “session times shifted” note.',
        'Your IV rhythm hypothesis: Asia lifts IV → London crushes it → the 17:30 Delta settlement brings a new rise → New York crushes it. Not yet measured by the terminal.'],
    },
    {
      id: 'days',
      title: 'Day of week',
      text: ['Research on BTC day-of-week effects is real but inconsistent. Treat these as tendencies to check against your own journal.'],
      table: {
        head: ['Day', 'Tends to happen', 'Rule'],
        rows: [
          ['Monday', 'Weekend price tested; sharp moves on returning liquidity', 'Asia moved and settled → normal gates from London; Asia quiet too → wait for the NY open to settle. Sell Wednesday expiry.'],
          ['Tuesday', 'Often calmer after Monday’s repricing', 'Good entry if the calendar is clear; check CPI.'],
          ['Wednesday', 'FOMC lands ~00:30 IST Thursday', 'No fresh strangle into FOMC unless IV prices it.'],
          ['Thursday', 'Positioning and rolls before Friday’s Deribit expiry', 'Sell Saturday expiry; it must survive Friday settlement, Friday data and the thin Saturday.'],
          ['Friday', 'Deribit settles 13:30 IST; NFP on the first Friday', 'No entry just before 13:30 or the 19:00 data.'],
          ['Saturday', 'Thin books', 'Half risk.'],
          ['Sunday', 'Thin until Monday Asia', 'Exit weekend trades on plan; don’t carry into the Monday open.'],
        ],
      },
    },
    {
      id: 'calendar',
      title: 'Calendar sizing (month × week × day)',
      text: ['The calendar only ever reduces size: size = base × month × week × day, rounded down; a product under 0.25 means skip. Starting values from published BTC volatility studies and the event calendar, not a strangle backtest; they will be replaced by your own heat map as the journal grows.'],
      list: [
        'Month: Jan 1.0 · Feb 0.5 · Mar 0.75 · Apr 0.5 · May 0.5 · Jun 0.75 · Jul 1.0 · Aug 0.75 · Sep 1.0 · Oct 0.5 · Nov 0.5 · Dec 0.75 (1.0 before 20 Dec).',
        'Week: W1 0.75 · W2 0.5 before CPI, 1.0 once CPI has settled · W3 1.0 (FOMC week 0.5 until the decision settles) · W4 0.75 (quarter-end or holiday-thin 0.5).',
        'Day of entry: Mon 0.5 (0.75 after the NY open settles) · Tue 1.0 · Wed 1.0 (FOMC day 0.5) · Thu 0.75 · Fri 0.5 before 13:30 or NFP, 0.75 after · Sat 0.5 · Sun 0.5.',
        'Week rating: Green = no top-tier release, normal liquidity · Amber = one top-tier event or a holiday/summer-thin week · Red = 2+ events, quarter-end expiry, a clock-change week, or holiday-thin.',
      ],
    },
    {
      id: 'months',
      title: 'Monthly playbook',
      table: {
        head: ['Month', 'Tendency', 'Plan'],
        rows: [
          ['Jan', 'Strong average, liquidity returns', 'Normal after the first week'], ['Feb', 'Strongest average, trend-prone; Chinese New Year', 'Half size; trend-side 0.10'],
          ['Mar', 'Mixed; quarter-end expiry; US DST', 'Normal; watch the transition weeks'], ['Apr', 'Strong, trend-prone', 'Half until the regime is clear'],
          ['May', 'Positive', 'Half; fast exits on the killer pattern'], ['Jun', 'Moderate; quarter-end expiry', 'Normal'],
          ['Jul', 'Moderate, low variation; summer-thin', 'Normal; dead-IV watch'], ['Aug', 'Weakest average; Jackson Hole', 'Half around Jackson Hole'],
          ['Sep', 'Negative, low variation', 'Normal size, only with sellable IV'], ['Oct', 'Strong, trend-prone (“Uptober”)', 'Smallest size of the year; no entry against a 4-of-6 trend'],
          ['Nov', 'Strong; US DST ends', 'Half until the trend is clear'], ['Dec', 'Mixed; thin 23 Dec–1 Jan', 'Normal early; half in the holiday week'],
        ],
      },
      text: ['Your own results (to be replaced by the journal heat map): Dec huge profit · Jan genuine profit · Feb stop-loss · May stop-loss · Jun strong · Jul good · Aug/Sep small · Oct bad two years running.'],
    },
    {
      id: 'psychology',
      title: 'Market and trader psychology',
      list: [
        'Crowd · Thin books (weekends, late US, quiet Asia) get pushed around; stop-runs are easier.',
        'Crowd · Leverage feeds liquidation cascades; sellers are hit by the 2nd and 3rd wave.',
        'Crowd · Fear is priced into puts after sell-offs: fat put premium appears exactly when risk is highest.',
        'Crowd · Events are bought, then dumped: IV rises into CPI/FOMC/expiry and often collapses after. Sell after, not before.',
        'Crowd · Pins are temporary: big OI strikes attract price into settlement, then release it.',
        'Crowd · Sellers are crowded too: when everyone is short vol, a surprise forces mass buy-backs.',
        'You · Winning streaks invite bigger size; the next trade is where accounts break. Size is fixed by rule.',
        'You · “It will come back” turns a 1:1 loss into 5:1. The exit level is set before entry.',
        'You · Revenge trading after a stop skips the gates. The daily stop exists for this.',
        'You · FOMO selling because premium looks fat: find out why it is fat first.',
        'You · Rule drift: every break is journaled, and the next 5 trades go at half size.',
      ],
    },
    {
      id: 'journal',
      title: 'Journal fields',
      list: [
        'Date, session, day (filled in for you)', 'Expiry and strike deltas', 'Gate readings (saved for you from the live checklist)',
        'Lots and risk %', 'Exit time, reason, net P&L, peak and max drawdown', 'Rules broken and why', 'One-line lesson',
      ],
    },
  ],
};
