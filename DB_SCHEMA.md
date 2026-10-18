# Volatility Desk: Database & Storage Schema Specification

**Canonical Source of Truth:** Managed PostgreSQL (Railway / Render)  
**Client-Side Offline Cache:** IndexedDB (`vol_desk_offline_cache`)  
**ORM / Schema Layer:** Drizzle ORM / TypeScript Types  
**Audit Basis:** [`ARCHITECTURE_AUDIT.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/ARCHITECTURE_AUDIT.md) | [`ARCHITECTURE.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/ARCHITECTURE.md)

---

## 1. Canonical PostgreSQL Relational Schema

### 1.1 Users & Authentication (`users`)
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    role VARCHAR(20) DEFAULT 'trader' CHECK (role IN ('trader', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.2 Encrypted API Credentials (`api_credentials`)
```sql
CREATE TABLE api_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange VARCHAR(50) NOT NULL CHECK (exchange IN ('delta_india', 'deribit', 'binance', 'telegram', 'ntfy')),
    api_key_encrypted TEXT NOT NULL,
    api_secret_encrypted TEXT,
    salt VARCHAR(64) NOT NULL,
    iv VARCHAR(32) NOT NULL,
    tag VARCHAR(32) NOT NULL,
    meta JSONB DEFAULT '{}', -- e.g. chat_id, ntfy_topic, testnet flag
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.3 Trades & Strangle Executions (`trades`)
```sql
CREATE TABLE trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    strategy VARCHAR(50) DEFAULT 'SHORT_STRANGLE',
    status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    underlying VARCHAR(20) DEFAULT 'BTC',
    expiry_date TIMESTAMPTZ NOT NULL,
    call_strike NUMERIC(12, 2) NOT NULL,
    put_strike NUMERIC(12, 2) NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    exit_time TIMESTAMPTZ,
    entry_spot NUMERIC(12, 2) NOT NULL,
    exit_spot NUMERIC(12, 2),
    entry_iv NUMERIC(6, 2) NOT NULL,
    exit_iv NUMERIC(6, 2),
    contracts NUMERIC(10, 4) NOT NULL,
    realized_pnl NUMERIC(12, 2),
    exit_reason VARCHAR(100), -- 'TAKE_PROFIT', 'STOP_LOSS', 'IV_REVERT', 'TIME_EXPIRY', 'PANIC'
    entry_greeks JSONB DEFAULT '{}', -- delta, gamma, theta, vega at open
    pnl_attribution JSONB DEFAULT '{}', -- delta_pnl, gamma_pnl, theta_pnl, vega_pnl
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.4 Trade Legs (`trade_legs`)
```sql
CREATE TABLE trade_legs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    leg_type VARCHAR(10) NOT NULL CHECK (leg_type IN ('CALL', 'PUT')),
    strike NUMERIC(12, 2) NOT NULL,
    entry_premium NUMERIC(12, 2) NOT NULL,
    exit_premium NUMERIC(12, 2),
    entry_iv NUMERIC(6, 2) NOT NULL,
    exit_iv NUMERIC(6, 2),
    status VARCHAR(20) DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'STOPPED')),
    stop_loss_level NUMERIC(12, 2),
    triggered_exit BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.5 Nightly Session Reviews (`nightly_reviews`)
```sql
CREATE TABLE nightly_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    verdict VARCHAR(20) NOT NULL CHECK (verdict IN ('SELL_FULL', 'SELL_HALF', 'NO_TRADE')),
    outcome VARCHAR(20) CHECK (outcome IN ('PROFIT', 'LOSS', 'SCRATCH', 'NO_ENTRY')),
    iv_1730 NUMERIC(6, 2),
    iv_ny_open NUMERIC(6, 2),
    iv_exit NUMERIC(6, 2),
    speed_vs_iv NUMERIC(6, 3),
    adx_trend VARCHAR(20), -- 'FALLING', 'FLAT', 'RISING'
    exit_hour INT,
    event_tags TEXT[], -- 'NFP', 'FED', 'EXP', 'VOTE', 'HOL'
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, session_date)
);
```

### 1.5 Chart Drawings & Annotations (`chart_drawings`)
```sql
CREATE TABLE chart_drawings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) DEFAULT 'BTCUSDT',
    drawing_type VARCHAR(50) NOT NULL, -- 'HORIZONTAL_RAY', 'TRENDLINE', 'BOX', 'TEXT'
    points JSONB NOT NULL, -- [{ time, price }]
    style JSONB NOT NULL, -- { color, lineWidth, lineStyle }
    label VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.6 User Workspace Preferences (`user_preferences`)
```sql
CREATE TABLE user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    theme VARCHAR(20) DEFAULT 'coinglass_dark',
    active_indicators JSONB DEFAULT '[]', -- list of enabled fx indicators
    chart_layout JSONB DEFAULT '{}', -- multi-pane heights, collapsed sections
    risk_limits JSONB DEFAULT '{}', -- max position size, max loss per night
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.7 Alert Rules & Delivery Logs (`alert_rules` & `alert_logs`)
```sql
CREATE TABLE alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rule_name VARCHAR(100) NOT NULL,
    rule_type VARCHAR(50) NOT NULL, -- 'IV_SPIKE', 'SPEED_BREAK', 'PANIC_EXPANSION', 'STOP_LOSS'
    threshold_value NUMERIC(10, 4) NOT NULL,
    channels TEXT[] DEFAULT ARRAY['telegram', 'ntfy', 'in_app'],
    cooldown_seconds INT DEFAULT 300,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE alert_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    channel VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'SENT' CHECK (status IN ('SENT', 'FAILED', 'SNOOZED')),
    delivered_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.9 Historical Market Timeseries (`market_timeseries`)
```sql
CREATE TABLE market_timeseries (
    time TIMESTAMPTZ NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    interval VARCHAR(10) NOT NULL, -- '1m', '5m', '15m', '1h', '1d'
    open NUMERIC(12, 2) NOT NULL,
    high NUMERIC(12, 2) NOT NULL,
    low NUMERIC(12, 2) NOT NULL,
    close NUMERIC(12, 2) NOT NULL,
    volume NUMERIC(16, 4) NOT NULL,
    dvol NUMERIC(6, 2),
    rv NUMERIC(6, 2),
    atm_iv NUMERIC(6, 2),
    open_interest NUMERIC(16, 4),
    PRIMARY KEY (symbol, interval, time)
);
```

### 1.10 Indicator Snapshots (`indicator_snapshots`)
```sql
-- Replaces IndexedDB suraj_ind_v1 ('rows') and suraj_archive_v1 5-minute recordings
CREATE TABLE indicator_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recorded_at TIMESTAMPTZ NOT NULL, -- 't' (5-min boundary)
    symbol VARCHAR(20) DEFAULT 'BTCUSDT' NOT NULL,
    term_current_n2n NUMERIC(6, 2), -- 'tc' (Current - N2N IV)
    term_next_n2n NUMERIC(6, 2), -- 'tn' (Next - N2N IV)
    forward_vol NUMERIC(6, 2), -- 'fwd'
    n2n_iv NUMERIC(6, 2), -- 'n2n'
    skew_25d NUMERIC(6, 2), -- 'rr' (25Δ put - call IV risk reversal)
    butterfly NUMERIC(6, 2), -- 'fly'
    master_expiry VARCHAR(20), -- 'se'
    atm_iv NUMERIC(6, 2), -- 'satm'
    funding_rate NUMERIC(10, 6), -- 'fund' (Delta BTCUSD perp funding)
    open_interest NUMERIC(16, 4), -- 'oi'
    liquidation_longs_usd NUMERIC(16, 2), -- 'liqL' (OKX longs liquidated USD)
    liquidation_shorts_usd NUMERIC(16, 2), -- 'liqS' (OKX shorts liquidated USD)
    raw_snapshot JSONB, -- lossless raw legacy snapshot bundle
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(symbol, recorded_at)
);
```

---

## 2. Repurposed Client-Side IndexedDB Cache Schema

The client-side IndexedDB database (`vol_desk_offline_cache`, v1) operates strictly as a high-performance local cache.

### Object Stores:
1. `kv_cache`: Fast key-value store for user preferences, active token, and UI state.
2. `trades_cache`: Mirror of user's active and recent trades for instant load without waiting for HTTP responses.
3. `drawings_cache`: Mirror of chart drawings rendered immediately onto Lightweight Charts canvases.
4. `timeseries_cache`: LRU cache of recent candle and indicator series (last 1,000 candles per timeframe) to allow smooth offline panning and zooming.
5. `sync_queue`: Queue of optimistic actions taken while disconnected to replay to PostgreSQL upon reconnection.
