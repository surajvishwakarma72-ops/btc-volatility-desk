# Volatility Desk: Browser Data Migration Specification

**Status:** Planned Migration Protocol  
**Target:** Ingestion of legacy browser-stored state into Canonical PostgreSQL  
**Audit Basis:** [`ARCHITECTURE_AUDIT.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/ARCHITECTURE_AUDIT.md)

---

## 1. Overview & Objective

Prior to full cutover to the full-stack architecture, existing operational data currently residing inside the user's browser must be exported and ingested into the managed PostgreSQL database.

This includes:
- Historical trade records and P&L attribution (`v99_trades`, `v18_cur`, `IndexedDB['v18:lab']`).
- Nightly calendar reviews and historical N2N session records (`v147_nights`, `ivcool:nights`).
- Active chart drawings, rays, and annotations (`btc_drawings_v1`).
- Custom macroeconomic and crypto events (`btc_vol_events_custom_v1`).
- User workspace configurations and indicator presets (`v132_ind`, `v143_skin`, `pa_layer_prefs_v3`).

---

## 2. Source Data Inventory to Migrate

### 2.1 `localStorage` Inventory

| Legacy Key | Data Type | Canonical PostgreSQL Target Table | Field Mapping / Transformations |
|---|---|---|---|
| `v99_trades` | JSON Array | `trades` | Array of closed strangle trades: entry date, exit date, strike call/put, entry IV, exit IV, realized P&L, exit reason. |
| `v99_trade` | JSON Object | `trades` | Currently active open strangle trade (status set to `'OPEN'`). |
| `v147_nights` | JSON Array | `nightly_reviews` | Array of 249+ tested night outcomes: date, N2N result, exit hour, rule tags (`NFP`, `FED`, `EXP`). |
| `ivcool:nights` | JSON Object | `nightly_reviews` | Historical IV cooling profiles and night statistics. |
| `btc_drawings_v1` | JSON Array | `chart_drawings` | Array of chart shapes: `{ id, type, points, color, width, label }`. |
| `btc_vol_events_custom_v1`| JSON Array | `custom_events` | User-created macroeconomic events and countdowns. |
| `v132_ind` | JSON Object / String | `user_preferences` | Map of active indicator visibility toggles for the `ƒx` menu. |
| `v143_skin` | String (`'0'` / `'1'`) | `user_preferences` | UI theme preference (CoinGlass skin vs classic). |
| `pa_layer_prefs_v3` | JSON Object | `user_preferences` | Overlay layer display preferences on primary BTC chart. |
| `vt_alert_prefs_v1` | JSON Object | `alert_rules` & `api_credentials` | Alert threshold levels, Telegram bot token/chat ID, and ntfy topic. |

### 2.2 `IndexedDB` Inventory

| Legacy Database | Store Name | Target Table | Notes |
|---|---|---|---|
| `v18:lab` | `trades` | `trades` | Detailed trade lab executions, Greeks snapshots, and P&L attribution. |
| `suraj_archive_v1` | `days` | `nightly_reviews` | Historical day-by-day options and IV dataset. |
| `suraj_ind_v1` | `rows` | Ephemeral / Recomputed | Indicator computation cache. Can be discarded as backend recomputes. |
| `v146fut` | `kv` | `market_timeseries` | Cached Binance BTCUSDT futures 5-min OI delta and taker flow. |
| `btc_desk_market_cache` | `kv` | Discard | Ephemeral raw candle cache; will be re-fetched directly by backend. |
| `btc_atm_iv_persistent_v30` | `state` | Discard | Legacy state cache superseded by Postgres schema. |

---

## 3. Migration Pipeline Architecture

```
┌─────────────────────────────────┐
│     TRADER BROWSER CONSOLE      │
│  (One-Time Export Script)       │
└────────────────┬────────────────┘
                 │ Generates unified JSON bundle: `volatility_desk_export_<timestamp>.json`
                 ▼
┌─────────────────────────────────┐
│     MIGRATION CLI / ENDPOINT    │
│  `POST /api/v1/migration/import`│
└────────────────┬────────────────┘
                 │
                 │ 1. Schema Validation (Zod / TypeBox)
                 │ 2. Deduplication check against existing records
                 │ 3. User foreign-key attribution
                 │ 4. Transactional Bulk Insertion (`BEGIN ... COMMIT`)
                 ▼
┌─────────────────────────────────┐
│      MANAGED POSTGRESQL         │
│  (Canonical System of Record)   │
└─────────────────────────────────┘
```

---

## 4. Verification & Cutover Criteria

1. **Checksum Verification:** Total trade count in `trades` table must exactly equal `v99_trades.length` + `v18:lab.length`.
2. **Night Count Parity:** Count of completed nights in `nightly_reviews` must match the 249+ tested nights in `v147_nights`.
3. **Drawing Parity:** User's visual chart rays and levels render at identical timestamps and prices in the new frontend.
4. **Credential Security:** Exchange API keys exported from browser are immediately encrypted with AES-256-GCM before storage in Postgres, and deleted from client `localStorage`.
