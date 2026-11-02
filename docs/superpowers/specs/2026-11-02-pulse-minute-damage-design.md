# Short Strangle lane: one-minute seller damage

## Why

The trader sells BTC short strangles. Their words: some moves cause no harm, and sometimes a tiny move blows capital, and they only learn which kind of market they are in once their own position is on. They want the simulated positions to take that hit first and tell them.

Today's Risk line feels like a copy of the candles. It updates every 15 minutes, blends eight inputs, averages several positions, and needs two readings to change zone. It has no measure of how much premium jumped per BTC move. The futures lines also react after a move, and that cannot be fixed, because a futures position's profit is the BTC price.

The goal is for the lane to answer, each minute: is this market forgiving or dangerous to a seller right now, and on which side?

## Goals

- Upgrade the existing Risk line. No new main line (the trader's decision).
- One point per minute on the lane for Risk, Call, Put and the futures lines, on the expiry chosen in the terminal.
- A new reading: premium damage per BTC move, separately for the call and the put, and a main input to Risk.
- A fast danger trigger: a sudden jump in damage puts Risk in the danger zone at once, without waiting for the average or the two-reading rule.
- Futures become the measure of the move and the confirmation of direction, not an early warning.
- A test that measures whether the new reading leads, using recorded data.

## Non-goals

- Promising to predict the next move.
- A new "sideways or directional" label or an automatic best-entry picker. Those wait for the test results.
- Changing the bot's strict strike rule, or the 0.10 to 0.15 delta rule for paper strangles.
- Changing the zone rules for the algo's existing conditions, other than Risk itself getting faster.

## Anti-goals

Failure even if it works technically:

- A line that is just a faster copy of the candles.
- A reading that gets called leading before the test shows it.
- Filling the server's disk or the database with minute data.
- Live strategies changing behaviour without the trader knowing. Risk feeds the "Short Strangle zone" algo condition, so see Rollout.

## Decisions

Made by the trader:

- Keep the Risk line and improve it.
- Prefer the strategy's expiry as chosen in the terminal.
- Futures open every hour; strangles open only inside 0.10 to 0.15 delta; older strangles run to their own expiry. Already live.

Made by Claude, for the trader to check:

- **Earlier warnings over fewer false alarms.** A false alarm costs one entry; a late warning can cost capital. The trader was asked and did not choose, so this is a default.
- **Damage measure.** For each side, the change in the leg's mid premium over a rolling 5 minutes as a percentage of its entry premium, divided by the absolute futures move over the same 5 minutes as a percentage. When the move is under a floor of 0.02%, use the floor, so a premium jump on a flat market reads as high damage rather than dividing by nearly zero. Premium falling reads as zero damage.
- **Damage score.** Damage maps to 0-100 with a fixed scale like the other inputs: 5 reads 0 and 30 reads 100 (5 means premium up 5% of entry for a 1% BTC move). Risk uses the worse of the two sides, not the average, because a one-sided blowup is the case the trader fears. The scale is a starting guess, reviewed after the leading test.
- **Weight.** Damage takes 30 of 100 Risk points; the other weights shrink in proportion. Untested judgement, like the existing weights.
- **Fast trigger.** Checked per side, with fixed levels and no percentile. It fires when a side's damage score is 100 and its premium is up at least 10% of entry in 5 minutes, for 2 minutes running. The second test stops a small wobble on a flat market firing it. It sets the zone to danger at once. After 10 minutes below those levels it clears, and the zone returns through the normal rule.
- **Zone changes.** Ordinary changes need 5 readings in a row instead of 2, so they take about 5 minutes rather than 30 and do not flip on noise.
- **Call and Put lines.** Each is 60% that side's damage score and 40% the existing line, held between 15-minute samples. Which side is hurting shows in the lane header.
- **Futures lines.** Long and short read BTC's signed move over the last 60 minutes on the existing 0-100 risk scale. They measure the move and confirm direction, and do not reset when a new position opens.
- **Which position.** Minute values read the newest open strangle on the chosen expiry. If none, the most recent older strangle on that slot. If none at all, the futures lines show and Risk is NO DATA.
- **Position changes.** A 5-minute change only compares rows of the same position. For the first 5 minutes after the newest strangle changes, the outgoing position stays the one measured and the new one is recorded alongside it, so an hourly switch makes no false spike and leaves no hole.
- **Missing damage.** With no damage reading, Risk may read at most WAIT. It never falls back silently to SELL on the old inputs.
- **Other seven inputs.** They stay blended across positions exactly as today. Only the damage part reads one position.

## How it works

The collector already reads the option chain and the futures price every 60 seconds (`TICK_MS` in `pulse-engine.ts`) and stores only a 15-minute sample. So minute data costs no extra market calls.

New table `pulse_minute`, one row per slot, position and minute: time, slot, cohort id, futures price, call mid, put mid, call and put IV, data_ok. Normally one position per slot, with a few extra rows at each hourly switch, so growth is about 4,500 rows a day. Rows older than 45 days are deleted. The table lives in the Neon database, not on the VM's disk. The 15-minute tables stay as they are, and the older positions keep their existing 15-minute records.

The score reads the minute rows for damage and for the lane's points. The other seven Risk inputs stay on their 15-minute values, held between samples. `/score` keeps its 45-second cache, which the lane and the algo condition share (`pulse-score.ts`), so the line updates about each minute.

The lane sends one point per minute for the last 48 hours as now, which is about 2,900 points per line, so the response must be checked for size on a 1 GB server. Charts on timeframes above 1 minute show the last value in each bar.

## Leading test

A read-only script over `pulse_minute`. For each minute, compare damage with what the premium and BTC did in the next 5, 15 and 30 minutes, against the same check using plain BTC movement. Fixed before any data is seen: a high reading is a damage score of 100, and a jump is a strangle's premium rising at least 20% of entry within 30 minutes. Report it in plain words: how often a high reading came before a jump, how early, and how often it was a false alarm. Needs at least 2 weeks of data and at least 20 real jumps before any conclusion, and the 45 days of data leave room to wait for them. The result can be "it does not lead", and that must be reported as it is.

## Constraints

- Oracle VM has 1 GB of memory and its disk is 91% full. Clear old rollback images before the next deploy.
- Deploys are run by the trader. Reading the live database is blocked for Claude, so live checks go through a script the trader runs.
- Show on localhost first when the machine has memory for it.
- Missing data stays missing: never invent a point to keep the line unbroken.
- Live trading is on.

## Rollout

The trader decided: the live algo stays on today's Risk until the test passes and they approve the switch.

0. Clear old rollback images, keeping the latest, and ship the normal-view chart fix.
1. Deploy the collector, so minute data starts building, with no change to Risk or the algo.
2. After about 48 hours, switch the lane to the minute reading behind a config flag. The "Short Strangle zone" condition keeps reading today's Risk, so the score must produce both readings. Label the new reading uncalibrated.
3. Run the leading test once it has enough data, and report the result as it is.
4. Connect the algo condition to the new reading only if the test passes and the trader approves.

Rollback: turning the flag off returns the lane to today's Risk and keeps the recorded data. Each deploy also keeps the previous version and rolls back automatically if the site fails its checks.

## Left to the builder

- Exact table indexes and the cleanup schedule.
- Trimming the `/score` response if it is too large.
- Wording in the "i" guide, which must describe the new reading, and how the futures lines changed role.
