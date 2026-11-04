# Build Prompt — Login Gate, Graphical User Tracker & Emergency Close-Only

Paste this into Antigravity, or save it in the repo root and tell the agent to follow it.

---

## 0. Goal and ground rules

Add secure multi-user access to my trading terminal:

1. A **login gate** in front of the whole terminal.
2. **Owner-approved password resets.**
3. A **graphical, clickable User Tracker panel** (owner only) — visuals, icons, colours and charts, not tables of text.
4. **Emergency close-only**: on a user's request, the owner can close that user's positions. The owner can never open, increase or modify a position in a user's account.

Rules for you (the agent):
- Explore first: find how the terminal currently serves pages, stores API keys, and connects to Delta Exchange per user. Write a short plan and wait for approval.
- Never place, modify or cancel an order while testing; use paper mode or a test account.
- Security checks run on the **server** for every request. Hiding a button in the UI is never the protection.
- Secrets (session keys, encryption keys, Telegram token) come from environment variables only.

---

## 1. Login gate

- Every visit opens on a **login screen**: user ID + password. No panel, data or WebSocket loads before login.
- Passwords stored only as **argon2 or bcrypt hashes**. Nobody, including the owner, can read a password.
- **Authenticator-app 2FA (TOTP):** mandatory for the owner, recommended for users (owner can make it mandatory per user).
- **Lockout:** 5 wrong attempts → account locked; only the owner can unlock.
- **Sessions:** secure HTTP-only cookies, auto-logout after inactivity (configurable, e.g. 30 min), "log out all devices" support.
- **Roles:** `owner` and `user`. A user sees only their own data. Role is checked on the server for every API call and WebSocket subscription.
- HTTPS only.

---

## 2. Password reset with owner approval

- User clicks **Forgot password** → a reset request enters the owner's **approval queue**. Nothing resets automatically.
- Owner approves or rejects from the User Tracker.
- On approval, the user gets a **one-time reset code** valid for 15 minutes, delivered by the channel set for them (Telegram or email).
- Owner can also **force reset**, **lock** or **unlock** any user directly.
- Every request, approval and rejection is logged.

---

## 3. User Tracker panel — graphical and clickable (owner only)

Design it as a visual control room, not a text table. Use the terminal's theme (light/dark) and existing chart library.

### 3.1 Top summary strip

Four tappable tiles, each with an icon, a big number and a mini chart:

| Tile | Shows | Click → |
| --- | --- | --- |
| Users | Total users, ring split: active / locked / reset pending | Filters the grid to that status |
| Online now | Count with live green pulse | Filters to online users |
| Open risk | Total open positions across users, bar per user | Filters to users with open positions |
| Alerts | Pending resets + failed logins + key errors, red badge | Opens the alerts drawer |

### 3.2 User cards grid

One **card per user**, arranged in a responsive grid (2 columns on phone, 4+ on desktop). Each card shows visually:

- **Avatar circle** with initials, and a **status ring**: green = active, grey = offline, red = locked, amber = reset pending.
- **Online dot** (pulsing when online).
- **API mode icon**: 👁 eye = read-only, ⚡ bolt = read + trade. Colour shows key health: green ok, amber stale, red failing.
- **Live P&L sparkline** for today, green above zero, red below, with the current figure.
- **Open positions gauge**: small donut showing number of open legs and margin used %.
- **Last login**: relative time ("5 min ago") with device icon (phone/desktop).
- **Emergency Close badge**: red shield icon if the user has opted in and has a trade key; greyed-out shield if not available.

**Every element is clickable:**

| Click on | Opens |
| --- | --- |
| Card / avatar | User detail page (section 3.3) |
| Status ring | Lock / unlock action sheet |
| API mode icon | Key health detail (masked key, last success, error reason) |
| P&L sparkline | User's P&L chart for the day |
| Positions gauge | User's open positions view |
| Last login | Login history with devices and IPs |
| Red shield | Emergency Close flow (section 4) |

Cards sort by: open risk, P&L, last active, alerts. A search box filters by user ID or name.

### 3.3 User detail page

Reached by clicking a card; has a back link and a **breadcrumb** ("User Tracker › Ravi") so navigation is always one tap.

- **Header:** avatar, status ring, API mode icon, online dot, quick-action buttons (Lock, Force reset, Log out all devices, Downgrade to read-only, Remove user).
- **Positions:** visual cards per position (strike, side, size, live P&L bar, distance to stop). Read-only for the owner.
- **P&L chart:** today and last 30 days, with peak and max-drawdown markers.
- **Login timeline:** dots on a timeline; red dots for failed attempts; tap a dot for device/IP.
- **Activity timeline:** resets, locks, key changes, emergency closes — each item clickable to its log entry.

### 3.4 Alerts drawer

Slides in from the side. Each alert is a clickable row with an icon:
- 🔑 Reset request → **Approve / Reject** buttons inline.
- ⛔ Account locked after failed logins → **Unlock** / view attempts.
- ⚠ API key failing → open key health.
- 🛡 Emergency close done → open its audit entry.

### 3.5 Visual rules

- Status is always shown by **colour + icon + shape**, never colour alone (works for colour-blind users).
- Every clickable element shows a hover/press state and has an accessible label.
- Works at phone width with no horizontal scrolling.
- Live elements (online dot, P&L, positions) update through the existing WebSocket, owner channel only.

---

## 4. Emergency close-only (owner, on the user's request)

Purpose: if a user's phone is dead or lost, they can ask the owner to close their positions.

**Hard limits — enforced on the server:**
- Only **reduce-only / close orders** are allowed. Anything that would open a position, add size, or modify/cancel other orders is rejected by the server.
- Available only for users who **opted in** at onboarding ("I allow the owner to close my positions on my request") **and** provided a read + trade key. Read-only users show the shield greyed out with "Not available — read-only key".

**Flow:**
1. Owner taps the red shield on the user's card.
2. Screen shows every open position to be closed, with estimated P&L, as visual cards.
3. Owner selects **Close all** or specific positions, enters a **reason** (e.g. "User called, phone dead") and their **2FA code**.
4. Orders are sent with live status (spinner + timer → ✓ / ✗ per leg); ✓ only after the exchange acknowledges.
5. The user is **notified immediately** (Telegram/email): what was closed, when, at what price, and the reason.
6. Everything is logged: requester, reason, owner, every order and fill.

**User self-service (first line of defence):**
- A Telegram bot command `/closeall` plus the user's personal PIN runs the same close-only logic from any phone, without needing the terminal or the owner.
- Wrong PIN 3 times → command locked and owner alerted.

---

## 5. API key storage

- Users' Delta API keys are **encrypted at rest** (server-side key from environment).
- The UI only ever shows keys masked (e.g. `••••a4f2`). The owner cannot view a full key.
- Read-only keys are never used for any order call — enforced in code.
- Users with trade keys are asked to **whitelist the server's IP** on Delta.

---

## 6. Audit log

Append-only log of: logins and failures, resets requested/approved/rejected, locks/unlocks, role or key changes, emergency closes, Telegram `/closeall` uses. Viewable as a filterable timeline in the owner area; each entry clickable to its detail.

---

## 7. Testing

- A logged-out browser cannot load any panel, data or WebSocket.
- A user cannot reach another user's data by changing an ID in a URL or API call.
- 5 wrong passwords lock the account; only the owner can unlock.
- A reset cannot complete without owner approval; the code expires after 15 minutes.
- Emergency close: server rejects any order that is not reduce-only; unavailable for read-only and non-opted-in users; user receives the notification.
- User Tracker: every tile, card element and alert opens the correct view; layout works at phone width and in both themes.

---

## 8. Phases

1. **Login gate, roles, sessions, lockout, 2FA.**
2. **Password reset approval queue.**
3. **User Tracker — summary tiles, user cards, detail page, alerts drawer.**
4. **Emergency close-only + Telegram `/closeall` + notifications.**
5. **Audit log timeline and full test pass.**

After each phase: summary, files changed, how to test, known limits.
