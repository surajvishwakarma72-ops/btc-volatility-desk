# Hindi Voice Plan 1: Voice in the Real Terminal on Localhost

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner opens the real terminal at http://localhost:4100, presses the mic button, and speaks Hindi to get market readings, position readings, term explanations and page navigation, in spoken Hindi.

**Architecture:** A pure `VOICE-CORE` block in `frontend/index.html` turns Hindi text into an intent and turns an intent plus data into a Hindi reply. A thin session layer around it uses Chrome speech. Hindi glossary text lives on the server. Everything runs in the existing `docker-compose.test.yml` stack, which has its own throwaway database and no Delta keys.

**Tech Stack:** Vanilla JS in the single-file frontend, Chrome Web Speech API, Fastify 5, TypeScript, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-02-hindi-voice-assistant-design.md`

## Scope and order

This plan is local only. Nothing here is deployed. It covers Stage 2 and the listening and speaking part of Stage 3, ahead of the design's order, because the owner asked to test voice locally. The trade flow, Stage 1 safety fixes and later stages get their own plans. **Stage 1 must be built before any voice code is deployed.**

## Global Constraints

- Local test: `docker compose -f docker-compose.test.yml up -d --build`, then http://localhost:4100. Never run the backend against `backend/.env`: it points at a real hosted database and would start the trading workers.
- Edit `frontend/index.html` only. Never edit `frontend/dist/index.html`. Keep the existing markers.
- No new dependencies and no paid service.
- Not-available line, exactly: `माफ कीजिए, ये जानकारी उपलब्ध नहीं है। इसके अलावा आप कुछ और पूछ सकते हैं।`
- Greeting, exactly: `नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?`
- 8 s silence: `क्या आप कुछ और पूछना चाहेंगे?` Then 30 s more: `ठीक है, जब ज़रूरत हो मुझे बुला लीजिए।` and close.
- This plan has no order-placing path. Voice "entry" requests get a spoken "not available yet" reply.
- Numbers are spoken the Indian way. Replies use Devanagari, with trading terms in English.

## Review Focus

1. Pulse has no data, is off, or `card` is null: the reply says data is unavailable and never invents a value. (Task 3)
2. A request fails, or returns 401 after the login expires: spoken failure, session stays usable. (Task 4)
3. Assistant hears its own voice: recognition stops while speaking, so its speech never becomes a question. (Task 4)
4. The word "नहीं" or an empty or English transcript: no crash, and unknown input gets the not-available line. (Task 2)
5. Device has no Hindi voice: on-screen message says so and the text reply still appears. (Task 4)

---

### Task 1: Hindi number and intent core

**Files:**
- Modify: `frontend/index.html` (add a `<script>` block just before the Voice Command Hook section, near line 67230)
- Test: `backend/src/lib/voice/voice-core.test.ts`

**Interfaces:**
- Produces, between `// VOICE-CORE-START` and `// VOICE-CORE-END`:
  - `hindiNumber(n: number): string`
  - `parseHindiNumber(text: string): number | null`
  - `normalizeHi(text: string): string`
  - `matchIntent(text: string): { id: 'market'|'positions'|'explain'|'navigate'|'help'|'repeat'|'slower'|'entry'|'unknown', term?: string, page?: string }`

- [ ] **Step 1: Write the failing tests**

Slice the core with the same `new Function` method as `backend/src/lib/ask/brain.test.ts`, and assert:

```ts
expect(V.hindiNumber(68000)).toBe('अड़सठ हज़ार');
expect(V.hindiNumber(120000)).toBe('एक लाख बीस हज़ार');
expect(V.hindiNumber(2400)).toBe('दो हज़ार चार सौ');
expect(V.parseHindiNumber('अड़सठ हज़ार')).toBe(68000);
expect(V.parseHindiNumber('डेढ़')).toBe(1.5);
expect(V.parseHindiNumber('ढाई')).toBe(2.5);
expect(V.parseHindiNumber('साढ़े सात')).toBe(7.5);
expect(V.parseHindiNumber('सवा दो')).toBe(2.25);
expect(V.parseHindiNumber('मौसम')).toBeNull();
expect(V.matchIntent('आज बाज़ार कैसा है?').id).toBe('market');
expect(V.matchIntent('आज बाजार कैसा है').id).toBe('market');
expect(V.matchIntent('मेरी पोजीशन कैसी है').id).toBe('positions');
expect(V.matchIntent('IV क्या है')).toMatchObject({ id: 'explain', term: 'iv' });
expect(V.matchIntent('आईवी क्या है')).toMatchObject({ id: 'explain', term: 'iv' });
expect(V.matchIntent('पेपर पेज दिखाओ')).toMatchObject({ id: 'navigate', page: 'pgPaper' });
expect(V.matchIntent('Strangle Pulse क्या है')).toMatchObject({ id: 'explain', term: 'strangle pulse' });
expect(V.matchIntent('एंट्री करनी है').id).toBe('entry');
expect(V.matchIntent('मदद').id).toBe('help');
expect(V.matchIntent('आज क्रिकेट का स्कोर क्या है').id).toBe('unknown');
expect(V.matchIntent('').id).toBe('unknown');
expect(V.matchIntent('hello world').id).toBe('unknown');
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/lib/voice/voice-core.test.ts`
Expected: FAIL with "VOICE markers not found"

- [ ] **Step 3: Implement the four functions**

`explain` wins only when the sentence asks what something means ("क्या है", "मतलब", "समझाओ", "बताओ") and names a known term. Reuse the number table and `hindiNumber` from the demo at `C:\Users\suraj\AppData\Local\Temp\claude\C--BTC-Volatility-Desk\8b01f4da-2cfc-4adf-803a-b0eb82b4a364\scratchpad\voice-demo\index.html`, copied into `VOICE-CORE`. Page words map to the `data-page` ids at `frontend/index.html:20623-20631`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/lib/voice/voice-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html backend/src/lib/voice/voice-core.test.ts
git commit -m "feat(voice): Hindi number and intent core"
```

### Task 2: Hindi glossary on the server

**Files:**
- Create: `backend/src/lib/ask/glossary-hi.ts`
- Modify: `backend/src/routes/ask.ts`
- Test: `backend/src/lib/ask/glossary-hi.test.ts`

**Interfaces:**
- Produces: `GLOSSARY_HI: HiEntry[]` where `HiEntry = { term: string; aliases: string[]; text: string; metric?: 'iv'|'rv'|'dvol'|'pulse' }`.
- Produces: `GET /api/v1/ask/hi-glossary`, authenticated, returning `{ success: true, entries: HiEntry[] }`.

- [ ] **Step 1: Write the failing test**

Assert: every entry has a `term`, at least one alias and Devanagari in `text`; terms are unique; and these terms exist: `iv`, `rv`, `delta`, `theta`, `gamma`, `vega`, `oi`, `strangle`, `strike`, `lot`, `expiry`, `n2n`, `strangle pulse`, `sell zone`, `wait`, `avoid`, `no data`, `paper trade`, `live trade`, `stop loss`, `margin`, `premium`. Assert the `strangle pulse` entry contains the Hindi statement that its score is not yet calibrated.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/lib/ask/glossary-hi.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Write the entries and the route**

Base meaning on `backend/src/lib/ask/glossary.ts` and `backend/src/lib/pulse/config.ts`, in 2 to 3 simple Hindi sentences. Add one entry for each main page and each Pulse veto. Do not include the Flash ribbon. Also change the Ask me header at `frontend/index.html:64207` to `pictures from your own data`, and drop "No outside AI, nothing leaves the browser." at line 62589, since voice uses Google recognition.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/lib/ask/glossary-hi.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/ask/glossary-hi.ts backend/src/lib/ask/glossary-hi.test.ts backend/src/routes/ask.ts frontend/index.html
git commit -m "feat(voice): Hindi glossary and route"
```

### Task 3: Reply composer

**Files:**
- Modify: `frontend/index.html` (inside `VOICE-CORE`)
- Test: `backend/src/lib/voice/voice-core.test.ts`

**Interfaces:**
- Consumes: Task 1 functions; `HiEntry`.
- Produces: `composeReply(intent, data): string`, with `data = { pulse?: PulseBody|null, positions?: { paper: {name:string, netPnl:number|null}[], delta: {symbol:string,size:number}[], deltaNote: string|null }|null, glossary?: HiEntry[], failed?: boolean }`. `pulse` is the body of `GET /api/v1/pulse/score?slot=n2n`, read through `card`.

- [ ] **Step 1: Write the failing tests**

```ts
const pulse = { card: { verdict: 'SELL NOW', zone: 'sell', confidence: 74.4, why: [], vetoes: [] } };
expect(V.composeReply({ id: 'market' }, { pulse })).toContain('चौहत्तर प्रतिशत');
expect(V.composeReply({ id: 'market' }, { pulse: { card: null } })).toBe(NA);
expect(V.composeReply({ id: 'market' }, { pulse: null })).toBe(NA);
expect(V.composeReply({ id: 'market' }, { pulse: { card: { ...pulse.card, verdict: 'NO DATA', confidence: null } } })).toBe(NA);
expect(V.composeReply({ id: 'unknown' }, {})).toBe(NA);
expect(V.composeReply({ id: 'explain', term: 'iv' }, { glossary: [{ term: 'iv', aliases: ['आईवी'], text: 'टेस्ट' }] })).toBe('टेस्ट');
expect(V.composeReply({ id: 'explain', term: 'zzz' }, { glossary: [] })).toBe(NA);
expect(V.composeReply({ id: 'positions' }, { positions: { paper: [], delta: [], deltaNote: null } })).toContain('कोई खुली पोज़िशन नहीं');
expect(V.composeReply({ id: 'entry' }, {})).toContain('अभी उपलब्ध नहीं');
expect(V.composeReply({ id: 'help' }, {})).toContain('बाज़ार कैसा है');
expect(V.composeReply({ id: 'market' }, { failed: true })).toContain('दिक्कत');
```

`NA` is the exact not-available line from Global Constraints.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/lib/voice/voice-core.test.ts`
Expected: FAIL, `composeReply` is not defined

- [ ] **Step 3: Implement `composeReply(intent, data)`**

Spoken verdicts: `SELL NOW` as "SELL ZONE", `WAIT` as "रुकने का समय", `AVOID` as "अभी ट्रेड से बचना चाहिए". `why` strings are English, so do not read them; read vetoes only through a Hindi map and skip unmapped ones. P&L is spoken in rupee or dollar units as the API gives it; check the unit in `backend/src/routes/algo.ts:217` before writing the template.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/lib/voice/voice-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html backend/src/lib/voice/voice-core.test.ts
git commit -m "feat(voice): Hindi reply composer"
```

### Task 4: Voice session in the terminal

**Files:**
- Modify: `frontend/index.html` (voice stub near lines 67413-67437; keep `window.voiceDispatch`)
- Test: `backend/src/lib/voice/voice-core.test.ts`

**Interfaces:**
- Consumes: `matchIntent`, `composeReply`, `dget` (`frontend/index.html:38025`), `window.showToast`.
- Produces: `createVoiceSession({ input, output, fetchData, navigate, onStatus, onLine, timers })`, placed in `VOICE-CORE` so it is testable, with `start()`, `stop()` and `hear(text)`. `input` has `start()`, `stop()`. `output` has `speak(text): Promise<void>`, `cancel()`, `hasHindiVoice(): boolean`.

- [ ] **Step 1: Write the failing tests**

Use fake `input`, `output` and timers. Assert:
- `start()` speaks the exact greeting, and `input.start` is called only after speaking ends.
- `input.stop` is called before every `output.speak`.
- After 8 s of silence the prompt is spoken; 30 s later the closing line is spoken and the session ends.
- "फिर से बोलो" repeats the last reply. "धीरे बोलो" sets rate 0.8.
- `hear('पेपर पेज दिखाओ')` calls `navigate('pgPaper')`.
- When `fetchData` rejects, the reply has "दिक्कत" and the session keeps listening.
- `hasHindiVoice() === false` calls `onStatus` with `no-hindi-voice`, and `onLine` still gets the reply.
- A second `hear` while a reply is in progress is ignored.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/lib/voice/voice-core.test.ts`
Expected: FAIL, `createVoiceSession` is not defined

- [ ] **Step 3: Implement the session, then wire it to Chrome**

Outside `VOICE-CORE`, replace the mic button's stub click handler with real wiring: `webkitSpeechRecognition` with `lang='hi-IN'` as `input`, `speechSynthesis` as `output`, the Web Audio beep for "listening" and low tone for failure, and a small transcript panel so a sighted helper can follow. `fetchData` calls `dget('/api/v1/pulse/score', {slot:'n2n'})`, `/api/v1/algo/open-positions` and `/api/v1/ask/hi-glossary`, with the glossary cached for the session. `navigate` clicks the `data-page` nav button. Check `dget`'s path argument format at line 38025 before use.

- [ ] **Step 4: Run all tests**

Run: `cd backend && npx vitest run src/lib/voice src/lib/ask`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html backend/src/lib/voice/voice-core.test.ts
git commit -m "feat(voice): spoken Hindi session in the terminal"
```

### Task 5: Run it locally and try it

**Files:** none, unless a defect is found.

- [ ] **Step 1: Full tests and type check**

Run: `cd backend && npx tsc --noEmit && npx vitest run`
Expected: both pass. Report any failure with its output.

- [ ] **Step 2: Start the local stack**

Run: `docker compose -f docker-compose.test.yml up -d --build`
Expected: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4100/` prints 200.

- [ ] **Step 3: Check it in a browser**

Log in with password `local-test-only`. Confirm the mic button opens a session with no console errors, and type-test the session through `hear` if a mic is unavailable. Pulse needs about 15 minutes of collection before it has a reading; until then "बाज़ार कैसा है" correctly gets the not-available line.

- [ ] **Step 4: Hand over to the owner**

Give the link and these phrases: आज बाज़ार कैसा है, IV क्या है, मेरी पोज़िशन कैसी है, पेपर पेज दिखाओ, मदद, फिर से बोलो, धीरे बोलो, आज क्रिकेट का स्कोर क्या है.
