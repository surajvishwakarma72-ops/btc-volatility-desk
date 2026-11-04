# Build Prompt v2 — Voice-First Hindi Assistant for the Trading Terminal

Paste this into Antigravity, or save it in the repo root and tell the agent to follow it. Build it after Strangle Pulse. This version replaces v1.

---

## 0. Purpose and ground rules

Build a **voice-first assistant** that lets anyone, including a person who cannot read or write, use the whole terminal by speaking Hindi. They must be able to understand the market, learn what everything means, and take a **paper or live trade without clicking or reading anything**.

Rules for you (the agent):

1. **Voice is the primary interface.** Every feature of the terminal must be reachable by voice. The screen is a helper, never a requirement.
2. **Terminal-only knowledge.** Answer only from terminal data, terminal actions and the terminal glossary. No web, no outside data, no general-knowledge answers. When something is not available, say exactly:
   **"माफ कीजिए, ये जानकारी उपलब्ध नहीं है। इसके अलावा आप कुछ और पूछ सकते हैं।"**
3. **The LLM understands; code decides.** The language model only turns speech into an intent with parameters, and turns results into Hindi sentences. Every trading step, check and confirmation runs in deterministic code (a state machine). The LLM can never place an order directly.
4. **Actions call the terminal's command API, not simulated clicks.** The screen highlights the matching button so a sighted helper can follow along.
5. **Explore, plan, then wait for approval** before writing code. Reuse the existing chat box flows, handlers, data layer and WebSocket.
6. **Secrets** come from environment variables only.

---

## 1. Professional voice pipeline

```
Mic (always-on while session open)
  → Voice activity detection (VAD) + noise suppression
  → Streaming speech-to-text (Hindi + Hinglish)
  → Normalizer (Hindi numbers, trading terms)
  → Intent + slot extraction (LLM with tool calling)
  → Dialog manager (state machine: flows, slots, confirmations, safety)
  → Command API → terminal handlers   |   Data tools → terminal data + glossary
  → Response composer (simple spoken Hindi)
  → Streaming text-to-speech (female Hindi voice) + earcons + on-screen transcript
```

**Speech engines.** Put STT and TTS behind interfaces so they can be swapped. Evaluate at least two options on my own recorded test set (section 9) and pick by accuracy and latency, not by brand:
- Indian-language specialists (e.g. Sarvam AI's speech models)
- Major clouds with `hi-IN` neural voices (Google Cloud Speech/TTS, Azure Speech)
- Realtime speech-to-speech APIs that support Hindi
- Browser Web Speech API only as a free fallback; it is not reliable enough to be the main engine.

**Latency budget:** first spoken word of the reply within ~1.5 s of me finishing speaking. Stream TTS so it starts speaking before the full reply is ready.

**Continuous two-way conversation:**
- Session opens with the mic button, a keyboard shortcut, or an optional wake word ("हेलो टर्मिनल").
- Greeting: **"नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?"**
- **Barge-in:** if I start speaking while it is talking, it stops and listens.
- After each answer, it keeps listening. After ~8 s of silence: "क्या आप कुछ और पूछना चाहेंगे?" After ~30 s more: "ठीक है, जब ज़रूरत हो मुझे बुला लीजिए।" and the session closes.
- It remembers context within the session ("उसका डेल्टा क्या है?" refers to the last strike discussed).

---

## 2. Built for someone who cannot read

- **Nothing requires reading.** Every number, status and warning is spoken.
- **Numbers spoken the Indian way:** "एक लाख बीस हज़ार", "दो हज़ार चार सौ रुपये", "शून्य दशमलव एक दो डेल्टा".
- **Plain words first, term second:** "बाज़ार अभी शांत है — यानी volatility कम है।"
- **Sound cues (earcons)** so the user knows the state without looking:
  - soft tick loop = working, please wait
  - rising chime = done
  - low double tone = failed or blocked
  - short beep = listening
- **Repeat and slow down:** "फिर से बोलो" repeats the last answer; "धीरे बोलो" slows the voice.
- **Help anytime:** "मदद" or "मैं क्या-क्या पूछ सकता हूँ?" lists what it can do, in 4–5 short examples.
- **Voice onboarding** on first use: a 2-minute spoken tour of the terminal, paper vs live, and how to stop a trade.

---

## 3. What the assistant can do (all by voice)

| Area | Example | Behaviour |
| --- | --- | --- |
| Market condition | "आज बाज़ार कैसा है?" | Strangle Pulse verdict, confidence, zone, top 3 reasons, in simple words |
| Explain | "IV क्या है?", "ये इंडिकेटर क्या है?", "टर्मिनल के बारे में बताओ" | Glossary answer, then the current live value if any |
| Positions | "मेरी पोज़िशन कैसी है?" | Open legs, P&L, risk level, distance to stop |
| Navigate | "Strangle Pulse दिखाओ" | Opens the panel and describes what is on it |
| Paper trade | "पेपर ट्रेड में एंट्री करो" | Full guided flow, no PIN needed |
| Live trade | "लाइव एंट्री करो" | Full guided flow with live safeguards (section 5) |
| Exit / adjust | "एग्ज़िट करो", "कॉल वाली साइड बंद करो" | Guided flow with read-back and confirmation |
| Alerts | "जब SELL ZONE आए तो बताना" | Sets a terminal alert, spoken when it fires |
| Settings | "मोड पेपर कर दो", "आवाज़ धीमी करो" | Changes the setting and confirms |
| Anything else | Off-topic or missing data | "माफ कीजिए, ये जानकारी उपलब्ध नहीं है। इसके अलावा आप कुछ और पूछ सकते हैं।" |

---

## 4. Guided trade flow (state machine)

```
START → choose mode (paper/live) → check verdict → choose expiry
      → strikes proposed (0.10–0.15 delta) → lot size → margin & risk check
      → full read-back → confirmation → submit → status → result → "आगे क्या करना है?"
```

Example (paper):

```
मैं:        "एंट्री करनी है"
Assistant:  "पेपर ट्रेड करना है या लाइव?"
मैं:        "पेपर"
Assistant:  "Strangle Pulse अभी SELL ZONE में है, भरोसा चौहत्तर प्रतिशत।
             करंट एक्सपायरी पर कॉल अड़सठ हज़ार और पुट इकसठ हज़ार सुझा रही हूँ। ठीक है?"
मैं:        "हाँ"
Assistant:  "कितने लॉट?"
मैं:        "दो"
Assistant:  "दो लॉट। कुल प्रीमियम लगभग एक हज़ार आठ सौ चालीस रुपये मिलेगा,
             स्टॉप लॉस दोगुने प्रीमियम पर लगेगा। पेपर ट्रेड लगा दूँ?"
मैं:        "हाँ, लगा दो"
Assistant:  [tick sound] "ऑर्डर भेज रही हूँ, कृपया प्रतीक्षा करें…"
            [chime] "पेपर ट्रेड लग गया। आगे क्या करना है?"
```

Rules:
- One question at a time. Unclear answer → ask again; never guess.
- "रुको", "कैंसल", "बंद करो", "नहीं" cancels the flow at any step and says what was cancelled.
- Every step narrated; the screen highlights the matching control.

---

## 5. Live-trade safeguards (voice-only, no clicking)

Because a live order can be confirmed without looking at a screen, safety must also be voice-based:

1. **Paper mode is the default** for every new user. Live mode is switched on only by the account owner during setup.
2. **Voice PIN for live orders.** A 4-digit PIN set during setup, spoken at the final step. Wrong PIN twice → live trading locked for the session.
3. **Full read-back before submit:** mode (LIVE spoken clearly), buy/sell, strikes, expiry, lots, premium, maximum loss at stop. Numbers read twice when they matter: "दो लॉट — दो".
4. **Explicit yes:** only "हाँ, कन्फर्म" / "हाँ, लगा दो" counts. Silence, "हम्म", or background speech never counts.
5. **Hard limits in config, set by the owner:** max lots per order, max open strangles, max daily loss. Above a limit, the assistant refuses and explains.
6. **Verdict warning:** if Strangle Pulse says AVOID or NO DATA: "अभी ट्रेड लेना जोखिम भरा है। फिर भी आगे बढ़ना है?" Requires a second yes.
7. **Margin check before submit;** if margin is short, say so and stop.
8. **Emergency stop:** "सब बंद करो" → reads back all open positions, asks once for confirmation, then exits everything.
9. **Audit log:** every voice session stores transcript, intent, action, confirmation and result (text only; audio not stored unless enabled).

---

## 6. Live status (voice and screen)

Every command moves through real states from the actual request lifecycle — never a fake timer:

| State | Sound | Spoken | Screen |
| --- | --- | --- | --- |
| Listening | short beep | — | pulsing mic |
| Working | tick loop | "कृपया प्रतीक्षा करें" if longer than 2 s; "अभी भी काम चल रहा है" every 10 s | spinner + elapsed seconds |
| Done | chime | result in one sentence | green ✓ |
| Failed | low tone | reason in plain Hindi | red ✗ |
| Timed out (e.g. 15 s) | low tone | "जवाब आने में देर हो रही है, स्टेटस चेक कर रही हूँ" | amber ⚠ |

- Spinner appears within 200 ms.
- For orders, Done only after exchange acknowledgement; on timeout, query the real order status before reporting.
- Duplicate submissions are blocked while an order is in flight.
- The same status system applies to the typed chat box.

---

## 7. Language handling

- Understand Hindi, Hinglish and English mixed in one sentence.
- **Custom vocabulary / phrase hints** for STT: IV, RV, IV/RV, delta, gamma, theta, vega, OI, strangle, strike, lot, expiry, N2N, Strangle Pulse, SELL ZONE, Delta Exchange, BTC, and their Hindi spellings.
- **Number normalizer:** "साढ़े सात", "डेढ़", "ढाई", "सवा", "अड़सठ हज़ार", "0.12", "बारह डेल्टा" all map to correct values.
- Replies in Devanagari script; trading terms stay in English where traders use them.

---

## 8. Knowledge base (glossary)

One editable file. Each entry: term, aliases (Hindi spellings and likely mishearings), simple Hindi explanation (2–3 sentences), how the terminal uses it, live metric key if any. Seed with every metric, indicator, veto, verdict, panel, mode and setting in the terminal, plus "paper trade", "live trade", "stop loss", "margin", "premium".

---

## 9. Testing (required before live mode is enabled)

- **Hindi test set:** at least 200 recorded utterances from me and 2–3 other people, including noise (fan, TV, traffic), covering questions, numbers and every trade step.
- **Targets:** intent accuracy ≥ 95%; number accuracy ≥ 99% after read-back; reply start ≤ 1.5 s.
- **Safety tests:** TV/background speech saying "एंट्री" or "हाँ" must not place an order; a wrong PIN must block; limit breaches must be refused; network loss mid-order must report the true status.
- **Off-topic tests:** cricket, weather, news must all get the "माफ कीजिए…" reply.
- **Usability test:** one person who does not read completes a full paper trade by voice alone.

---

## 10. Build phases

1. **Live status system** for the existing chat box (section 6). Ship this first.
2. **Glossary + read-only data tools**, tested by typed Hindi questions.
3. **Voice pipeline:** VAD, streaming STT, TTS, barge-in, greeting, silence handling, earcons. Engine evaluation on the test set.
4. **Dialog manager + paper trade flow**, end to end by voice.
5. **Live-trade safeguards:** PIN, limits, read-back, verdict warning, emergency stop, audit log.
6. **Voice onboarding, help, repeat/slow commands, alerts.**
7. **Full test pass (section 9)**, then the owner enables live mode.

After each phase: summary of what changed, how to test, known limits.
