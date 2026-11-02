# Hindi Voice Assistant: Design

Date: 2 Nov 2026
Source brief: `terminal_voice_assistant_build_prompt.md` (v2). That brief still applies except where this document changes it. Where they differ, this document wins.

## 1. Intent

A person who does not know English and cannot type should be able to understand the terminal and take a trade by speaking Hindi. Each person trades their own money from their own Delta Exchange account.

Success is this: someone who cannot read completes a full paper trade by voice alone, and can ask about anything in the terminal and get either a correct simple Hindi answer or the fixed "not available" line.

## 2. Decisions the owner made

1. **Own account.** Each user trades their own money on their own Delta account.
2. **Verification.** Owner's request: the terminal verifies the person before an entry. Accepted method: trusted device plus spoken 4-digit PIN (section 6). The registered email stays as the account record and the way to recover the account.
3. **Terminal-only knowledge.** Anything not in the terminal gets exactly: "माफ कीजिए, ये जानकारी उपलब्ध नहीं है। इसके अलावा आप कुछ और पूछ सकते हैं।"
4. **The "no outside AI" promise is removed.** Update the Ask me header text (`frontend/index.html`, near line 64207).
5. **Zero running cost.** Nothing paid, for the owner or the users.
6. **Free version first.** Browser speech plus our own Hindi rules. Voice live orders stay off unless this version passes the owner's tests in section 9.

## 3. Calls made by Claude (owner has not specifically decided these)

- Build order in section 8, with live safety fixes first.
- Trading advice: "should I buy?" gets the Strangle Pulse reading and reasons, never a personal tip.
- First setup is done once by a helper: login, Delta keys, PIN.
- Voice recognition of the speaker is not used, and email or SMS codes are not used at entry.
- **Confirmation token** applies to human entries (at the route). Armed strategies have no person present, so they skip it.
- **Limits** apply to every live entry, including armed strategies and adopted positions, so they sit at `liveBroker.place`. Exits and stops are never blocked by limits or approval.
- **Limits are per user and set by the owner.** Lot limits must allow the normal 50-lot template unless the owner sets lower. Daily loss means realised plus open P&L on the IST day, including positions opened outside the terminal. If the data cannot be read, new entries are refused.
- **Helper** is not a role. It is someone using the user's own account during setup. Trusting a new device and resetting a PIN need owner approval, using the existing password reset approval flow as the model.
- **Emergency Stop** closes all real BTC option positions on the user's Delta account, cancels pending orders, and closes the user's paper positions. It needs a trusted device and one confirmation, no PIN. It works even when the user is not armed, is in dry-run, the desk is halted, or `LIVE_TRADING_ENABLED` is off. It says aloud that Delta futures are not covered.
- **Wrong-PIN lock** is voice-only and lasts until the next IST day or until the owner clears it. Live trading by click still works. Emergency Stop still works by voice.
- **Live preconditions:** owner approval comes on top of ARM and GO LIVE. The helper does these at setup. Voice refuses a live order in dry-run and says nothing was sent.
- **At the Stage 1 deploy,** users already live are treated as approved, so nobody with open positions gets stuck. Limits take effect once the owner sets them.

## 4. Goals, non-goals, anti-goals

Goals:
- Every terminal page, metric, verdict and setting can be explained in simple Hindi.
- Live values are spoken: Pulse verdict and reasons, IV, the user's own positions and P&L.
- Guided paper trade by voice, on the user's own Paper account.
- Live safety fixes that protect every user, voice or not.
- Live voice entry and exit, built behind a switch and off until the tests pass.

Non-goals for this version:
- Paid speech or AI services. Keep speech behind interfaces so they can be swapped later.
- The LLM layer in the brief's pipeline. Rules replace it.
- Wake word, native apps, non-Chrome browsers, Hindi on-screen UI.
- Live futures by voice (live futures do not exist in the terminal).

Anti-goals, failures even if everything else works:
- An order placed from background speech or an unclear answer.
- A spoken number different from what is placed.
- An invented answer, including advice from outside the terminal.
- "Done" spoken when the order did not actually complete.
- One user hearing another user's data.

## 5. How it works

Runs in the browser, inside the existing single file `frontend/index.html` (there is no build step; do not edit `frontend/dist/index.html`). Keep the existing test markers (`ASKTRADE-CORE`, `WIZARD-CORE`, `ASKBRAIN-CORE`) and add a new marker block for the Hindi code so it can be tested the same way.

```
Chrome SpeechRecognition (hi-IN)
  → Hindi normaliser (numbers, trading terms, mishearings)
  → Hindi rule matcher → intent + values
  → Dialog state machine on the server for trades
  → Existing terminal APIs and data
  → Fixed Hindi reply templates
  → Chrome speechSynthesis (hi-IN) + sound cues + on-screen text
```

- **Speech** sits behind `SpeechInput` and `SpeechOutput` interfaces, so a paid engine can replace them. Chrome sends audio to Google for recognition. This is the accepted outside service. Nothing else leaves the terminal.
- **Understanding** is deterministic rules. There is no LLM, so the brief's "the LLM can never place an order" is met automatically.
- **Replies** are templates filled with real values. Numbers are spoken the Indian way.
- **No match** gives the "not available" line. On a trade step, it asks again instead.
- **Session behaviour** follows the brief: greeting, keeps listening, silence prompts at 8 s and 30 s more, "फिर से बोलो", "धीरे बोलो", "मदद". Barge-in is best effort, because the browser may hear its own voice.
- **Start** is the existing mic button (`vVoiceBtn`, currently a stub near line 67360) or a keyboard shortcut. A person who cannot read needs the button large and obvious.
- **Sound cues** are generated in the browser with no audio files or cost.
- **Status** states (Listening, Working, Done, Failed, Timed out) come from real request results, as in brief section 6, and apply to the typed chat too.
- **Context** within a session: "उसका डेल्टा क्या है?" refers to the last strike discussed.

### Knowledge

- One editable file extends the existing glossary (`backend/src/lib/ask/glossary.ts`, `glossary-more.ts`): Hindi explanation, Hindi aliases, likely mishearings, metric key.
- Add entries for Strangle Pulse and each of its verdicts, zones, components and vetoes, for each page, and for the modes and settings.
- Do not read the Flash ribbon aloud (hard-coded numbers near line 46565).
- State that the Pulse score is uncalibrated when explaining what it means.

### Data the assistant needs that the chat lacks today

- The user's own Paper and real Delta positions (`/ask` positions shows only the shared paper bot).
- Pulse score, zone and reasons, from `/pulse/score`.
- Handle `PULSE_ENABLED` being off by saying the data is unavailable.
- Decide and Entry Gauge are computed in the browser: read them from the page. The assistant runs in the page, so this is acceptable.

## 6. Verification

- **Trusted device:** a helper logs in once with the registered email and connects Delta keys. Trust must be a server-side record for that user and device, revocable by the owner, not just the 30-day login.
- **PIN:** 4 digits, set in setup by a helper, stored only as a salted hash on the server. Paper trades need no PIN.
- **Live orders and live exits except Emergency Stop:** PIN spoken at the final step, every order.
- **Wrong PIN twice** locks live voice orders as set out in section 3. Keep the lock in the database so a restart cannot clear it.
- **Forgotten PIN:** the helper requests a reset after email login, and the owner approves it. Phone-call reset is not in this version.
- **Known limit:** the spoken PIN passes through Google recognition and can be overheard. It is accepted because the PIN alone is useless without the trusted device.

## 7. Trade flows

Follow brief sections 4 and 5 for steps, wording, read-back, explicit yes, verdict warning and emergency stop, with these requirements:

- The state machine and the final confirmation live on the server. The server issues a short-lived, single-use preview token bound to user, mode, strikes, expiry, lots and side. Live placement without a matching token is refused.
- Only "हाँ, कन्फर्म" or "हाँ, लगा दो" counts as yes on the final step. Recognition with low confidence counts as unclear.
- If the assistant is speaking, recognised speech does not count as a confirmation.
- Paper trades use `/api/v1/paper/*`. Live trades use `/api/v1/algo/*`.
- Voice for a live strangle's single side and for live stop edits are later work: the APIs do not exist. The assistant says so.
- Add a Pulse zone alert type, because "जब SELL ZONE आए तो बताना" has no rule type today. Alerts are spoken only while the page is open; say this to the user.

## 8. Build order

Each stage ships on its own.

**Stage 1. Safety fixes for the existing terminal, needed with or without voice**
1. Server-enforced limits on live entry: max lots per order, max open strangles, max daily loss.
2. Real margin check before a live entry.
3. Server-side confirmation token for live entry.
4. Kill switch actually blocks live entries and the algo engine.
5. Exit all reports the truth: check `live.sent`, and show cooldown, failed and incomplete results. Emergency exit must work when the user is not armed or is in dry-run, if real positions exist.
6. Entry orders carry `client_order_id`, and a timeout checks the real order status before reporting. Duplicate submits are blocked.
7. Persist locks, cooldown, halt flag and revoked tokens across restarts. `authenticate()` checks revocation.
8. Close the data leaks: user filters on `manual_trades`, `pnl`, `nights`, `audit`, `alerts` in `backend/src/services/ask/answer.ts`; auth on `GET /alerts`, `POST /alerts/:id/ack`, `POST /iv/record`; the `/delta/signed` no-header path.
9. Owner approval per user before they can go live.
10. Live status system for the typed chat.

**Stage 2. Hindi knowledge and data answers,** tested by typed Hindi. The normaliser must keep Devanagari; the existing `norm` strips it.

**Stage 3. Voice and paper trading:** speech, sound cues, session handling, server dialog machine, guided paper trade.

**Stage 4. Help and onboarding:** spoken tour, alerts, spoken settings.

**Stage 5. Live by voice:** PIN, trusted device, read-back, verdict warning, emergency stop, audit log of transcript, intent, action, confirmation and result. Built behind a server switch that is off.

## 9. Test gate

Use brief section 9: 200+ recorded utterances, the safety tests, off-topic tests, and the usability test with a person who does not read. Because Chrome recognition cannot take recorded files directly, utterances are played aloud to the device or tested by speaking.

The gate for turning on live voice is: intent accuracy at least 95%, number accuracy at least 99% after read-back, every safety test passing, and the owner turning on the switch.

If the gate fails, voice stays paper-only. Live trading by click is unaffected.

The brief's 1.5 s reply target stays as a goal but does not block the gate, because the free speech engines are outside our control.

## 10. Constraints

- Hosting stays as is: Oracle free VM with 512 MB for the app, one process. No audio passes through the server.
- HTTPS already exists through Caddy, which the mic requires.
- Secrets from environment variables only.
- `LIVE_TRADING_ENABLED` is global: check its production value on the VM before Stage 5.
- Works only while the page is open, in Chrome.
- Devices: Android phones and computers, with phones as the priority. Test on a real Android phone before Stage 3, and run the Section 9 test gate on phones too.

## 11. Left to the builder

- Rule matcher structure and how phrases are stored.
- Database tables for PIN, device trust, confirmation tokens and voice audit.
- Default values for limits, within the owner setting them.
- Exact sound cue design and mic button look.
- The spoken wording not fixed by the brief, kept simple.
