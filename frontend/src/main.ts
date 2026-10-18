import './style.css';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';

// State container
interface AppState {
  spotPrice: number | null;
  dvol: number | null;
  markPrice: number | null;
  workersStatus: string;
  activeTrade: any | null;
  nightReviews: any[];
  drawings: any[];
  candles: any[];
  flowBuckets: any[];
}

const state: AppState = {
  spotPrice: 82015,
  dvol: 37.84,
  markPrice: 81984,
  workersStatus: 'CONNECTED',
  activeTrade: null,
  nightReviews: [],
  drawings: [],
  candles: [],
  flowBuckets: [],
};

let chart: IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;

/**
 * Initializes the full application layout
 */
function renderApp() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <!-- Top Header & Live Ticker -->
    <header class="top-nav">
      <div class="brand">
        <div class="brand-logo">Ω</div>
        <div>
          <div class="brand-title">BTC VOLATILITY DESK</div>
        </div>
        <span class="brand-badge">Institutional</span>
      </div>

      <div class="ticker-strip">
        <div class="ticker-item">
          <span class="ticker-label">BTC Spot (Binance)</span>
          <span class="ticker-val" id="ticker-spot">
            <span class="status-indicator"></span>
            $${state.spotPrice ? state.spotPrice.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '---'}
          </span>
        </div>
        <div class="ticker-item">
          <span class="ticker-label">Deribit DVOL</span>
          <span class="ticker-val" style="color: #60a5fa;" id="ticker-dvol">
            ${state.dvol ? state.dvol.toFixed(2) + '%' : '---'}
          </span>
        </div>
        <div class="ticker-item">
          <span class="ticker-label">Delta Mark</span>
          <span class="ticker-val" style="color: #f59e0b;" id="ticker-mark">
            $${state.markPrice ? state.markPrice.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '---'}
          </span>
        </div>
        <div class="ticker-item">
          <span class="ticker-label">24/7 Workers</span>
          <span class="ticker-val" style="color: #34d399; font-size: 0.82rem;" id="ticker-workers">
            ● 3/3 CONNECTED
          </span>
        </div>
      </div>

      <div class="nav-actions">
        <button class="btn btn-secondary" id="btn-refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Sync
        </button>
        <button class="btn btn-primary" id="btn-test-alert">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          Test Alert
        </button>
      </div>
    </header>

    <!-- Main Workspace Grid -->
    <main class="dashboard-grid">
      <!-- Left Column: Chart & Active Strangle -->
      <section style="display: flex; flex-direction: column; gap: 1.25rem;">
        
        <!-- Active Strangle Position Card -->
        <div class="card" id="strangle-card">
          <div class="card-header">
            <div class="card-title">
              <span style="color: var(--accent-amber);">⚡</span>
              <span>Active Strangle Execution</span>
            </div>
            <span class="badge-verdict sell-full" id="strangle-status">POSITION ACTIVE</span>
          </div>
          <div class="card-body">
            <div class="strangle-banner">
              <div class="metric-box">
                <span class="metric-title">Call Strike / Put Strike</span>
                <span class="metric-value" style="color: #60a5fa;" id="strangle-strikes">84,800 / 81,600</span>
              </div>
              <div class="metric-box">
                <span class="metric-title">Entry Spot Price</span>
                <span class="metric-value" id="strangle-entry-spot">$83,217.00</span>
              </div>
              <div class="metric-box">
                <span class="metric-title">Current Spot / Distance</span>
                <span class="metric-value" id="strangle-current-spot">$82,015.00</span>
              </div>
              <div class="metric-box">
                <span class="metric-title">Realized / Trajectory P&L</span>
                <span class="metric-value loss" id="strangle-pnl">-$289.54 USD</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Lightweight Charts Canvas -->
        <div class="card chart-panel">
          <div class="card-header">
            <div class="card-title">
              <span>BTC/USDT Technical Canvas</span>
              <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Neon Time-Series)</span>
            </div>
            <div class="chart-toolbar">
              <button class="interval-pill active" data-int="1d">1D</button>
              <button class="interval-pill" data-int="1h">1H</button>
              <button class="interval-pill" data-int="15m">15M</button>
              <button class="interval-pill" data-int="1m">1M</button>
            </div>
          </div>
          <div class="card-body" style="padding: 0;">
            <div id="chart-container"></div>
          </div>
        </div>

        <!-- Historical Day Coach Calendar Table -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <span style="color: #34d399;">📅</span>
              <span>Day Coach — Historical Night Sessions</span>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted);" id="nights-count">60 Sessions Migrated</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="data-table-wrap">
              <table class="data-table" id="nights-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Verdict</th>
                    <th>Outcome</th>
                    <th>IV 17:30</th>
                    <th>IV NyOpen</th>
                    <th>Exit IV</th>
                    <th>Speed/IV</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody id="nights-tbody">
                  <tr><td colspan="8" style="text-align: center; padding: 20px;">Loading historical night sessions...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </section>

      <!-- Right Column: 24h Clock, Greeks & 15m Options Flow -->
      <aside style="display: flex; flex-direction: column; gap: 1.25rem;">
        
        <!-- 24-Hour Circular Trade Clock -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <span style="color: #f59e0b;">⏱</span>
              <span>24h Session Trade Clock</span>
            </div>
            <span style="font-size: 0.72rem; color: #f59e0b; font-weight: 700;">UTC</span>
          </div>
          <div class="card-body clock-display">
            <div class="clock-canvas-wrap">
              <canvas id="clock-canvas" width="200" height="200"></canvas>
              <div class="clock-center-info">
                <div class="clock-time" id="live-utc-time">00:00:00</div>
                <div class="clock-session" id="live-session-name">NIGHT REVIEW</div>
              </div>
            </div>

            <div class="session-legend">
              <div class="session-pill" id="pill-asia">
                <span>Tokyo / Asia</span>
                <span>00:00 - 09:00</span>
              </div>
              <div class="session-pill" id="pill-london">
                <span>London Open</span>
                <span>07:00 - 16:00</span>
              </div>
              <div class="session-pill" id="pill-ny">
                <span>NY Cash Open</span>
                <span>13:30 - 20:00</span>
              </div>
              <div class="session-pill active" id="pill-night">
                <span>Night IV Play</span>
                <span>17:30 - 07:00</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 15-Minute Options Flow Buckets -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <span style="color: #8b5cf6;">🌊</span>
              <span>15m Deribit Options Flow</span>
            </div>
            <span style="font-size: 0.72rem; color: var(--text-muted);">Real-time</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="data-table-wrap" style="max-height: 220px;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Call Vol</th>
                    <th>Put Vol</th>
                    <th>Trades</th>
                  </tr>
                </thead>
                <tbody id="flow-tbody">
                  <tr><td colspan="4" style="text-align: center; padding: 15px;">Loading flow...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Active Technical Levels / Anchors -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">
              <span style="color: #06b6d4;">📌</span>
              <span>Session Anchors & Levels</span>
            </div>
            <span style="font-size: 0.72rem; color: var(--text-muted);" id="drawings-count">10 Levels</span>
          </div>
          <div class="card-body" style="padding: 0;">
            <div class="data-table-wrap" style="max-height: 160px;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Type</th>
                    <th>Price</th>
                  </tr>
                </thead>
                <tbody id="drawings-tbody">
                  <tr><td colspan="3" style="text-align: center; padding: 10px;">Loading levels...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </aside>
    </main>

    <!-- Bottom Status Bar -->
    <footer class="bottom-bar">
      <div class="bottom-bar-left">
        <span>PostgreSQL (Neon): <b style="color: #34d399;">CONNECTED</b></span>
        <span>Fastify REST API: <b style="color: #60a5fa;">PORT 4000</b></span>
        <span>WebSocket: <b style="color: #f59e0b;">LIVE</b></span>
      </div>
      <div>
        <span>BTC Volatility Desk v2.0 · Migrated from Browser Storage</span>
      </div>
    </footer>
  `;

  // Attach event handlers
  document.getElementById('btn-refresh')?.addEventListener('click', () => loadAllData());
  document.getElementById('btn-test-alert')?.addEventListener('click', () => sendTestAlert());

  // Initialize Canvas Clock
  drawClock();
  setInterval(drawClock, 1000);

  // Initialize Lightweight Charts
  initChart();

  // Load all initial data from REST API
  loadAllData();

  // Poll live market worker status every 2.5s
  setInterval(pollWorkerStatus, 2500);
}

/**
 * Initializes TradingView Lightweight Charts canvas
 */
function initChart() {
  const container = document.getElementById('chart-container');
  if (!container) return;

  chart = createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#0b0e14' },
      textColor: '#9ca3af',
      fontSize: 11,
      fontFamily: 'JetBrains Mono',
    },
    grid: {
      vertLines: { color: 'rgba(30, 38, 56, 0.4)' },
      horzLines: { color: 'rgba(30, 38, 56, 0.4)' },
    },
    crosshair: {
      vertLine: { color: '#3b82f6', width: 1, style: 3 },
      horzLine: { color: '#3b82f6', width: 1, style: 3 },
    },
    timeScale: {
      borderColor: '#1e2638',
      timeVisible: true,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: '#1e2638',
    },
  });

  candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#10b981',
    downColor: '#ef4444',
    borderVisible: false,
    wickUpColor: '#10b981',
    wickDownColor: '#ef4444',
  });

  // Handle responsive resizing
  window.addEventListener('resize', () => {
    if (chart && container) {
      chart.applyOptions({ width: container.clientWidth });
    }
  });
}

/**
 * Draws the 24-hour circular session dial on HTML5 canvas
 */
function drawClock() {
  const canvas = document.getElementById('clock-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 80;

  ctx.clearRect(0, 0, width, height);

  // Outer track circle
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#1e2638';
  ctx.lineWidth = 14;
  ctx.stroke();

  // Draw session arcs
  const drawArc = (startHour: number, endHour: number, color: string) => {
    const sAngle = (startHour / 24) * 2 * Math.PI - Math.PI / 2;
    const eAngle = (endHour / 24) * 2 * Math.PI - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, sAngle, eAngle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 14;
    ctx.stroke();
  };

  // Asia (00 - 09 UTC)
  drawArc(0, 9, 'rgba(59, 130, 246, 0.4)');
  // London (07 - 16 UTC)
  drawArc(7, 16, 'rgba(16, 185, 129, 0.4)');
  // New York (13:30 - 20:00 UTC)
  drawArc(13.5, 20, 'rgba(245, 158, 11, 0.4)');
  // Night Review Window (17:30 - 24:00 UTC)
  drawArc(17.5, 24, 'rgba(239, 68, 68, 0.5)');

  // Calculate current UTC time
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const handAngle = (utcHours / 24) * 2 * Math.PI - Math.PI / 2;

  // Active Hand indicator
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(handAngle) * (radius + 8), cy + Math.sin(handAngle) * (radius + 8));
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Update center text
  const timeElem = document.getElementById('live-utc-time');
  if (timeElem) {
    const h = String(now.getUTCHours()).padStart(2, '0');
    const m = String(now.getUTCMinutes()).padStart(2, '0');
    const s = String(now.getUTCSeconds()).padStart(2, '0');
    timeElem.innerText = `${h}:${m}:${s}`;
  }
}

/**
 * Loads all data from the Fastify REST backend
 */
async function loadAllData() {
  await Promise.allSettled([
    loadCandles(),
    loadActiveTrade(),
    loadNightReviews(),
    loadDrawings(),
    loadFlow(),
  ]);
}

/**
 * Loads historical candles from PostgreSQL
 */
async function loadCandles() {
  try {
    const res = await fetch('/api/v1/market/candles?symbol=BTCUSDT&interval=1d&limit=100');
    const json = await res.json();
    if (json.success && Array.isArray(json.data) && candleSeries) {
      const formatted = json.data.map((c: any) => ({
        time: c.time.split('T')[0],
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }));
      candleSeries.setData(formatted);
      if (chart) chart.timeScale().fitContent();
    }
  } catch (err) {
    console.error('Failed to load candles:', err);
  }
}

/**
 * Loads active strangle position
 */
async function loadActiveTrade() {
  try {
    const res = await fetch('/api/v1/trades?limit=1');
    const json = await res.json();
    if (json.success && json.data?.length > 0) {
      const trade = json.data[0];
      const strikesEl = document.getElementById('strangle-strikes');
      const entrySpotEl = document.getElementById('strangle-entry-spot');
      const pnlEl = document.getElementById('strangle-pnl');

      if (strikesEl) strikesEl.innerText = `${Number(trade.callStrike).toLocaleString()} / ${Number(trade.putStrike).toLocaleString()}`;
      if (entrySpotEl) entrySpotEl.innerText = `$${Number(trade.entrySpot).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      if (pnlEl) {
        const pnl = Number(trade.realizedPnl);
        pnlEl.innerText = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USD`;
        pnlEl.className = pnl >= 0 ? 'metric-value profit' : 'metric-value loss';
      }
    }
  } catch (err) {
    console.error('Failed to load trade:', err);
  }
}

/**
 * Loads historical night reviews table
 */
async function loadNightReviews() {
  try {
    const res = await fetch('/api/v1/nights?limit=15');
    const json = await res.json();
    const tbody = document.getElementById('nights-tbody');
    if (!tbody || !json.success) return;

    if (!json.data.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No reviews recorded.</td></tr>';
      return;
    }

    tbody.innerHTML = json.data
      .map((r: any) => {
        const vClass = r.verdict === 'SELL_FULL' ? 'sell-full' : r.verdict === 'SELL_HALF' ? 'sell-half' : 'no-trade';
        return `
          <tr>
            <td>${r.sessionDate}</td>
            <td><span class="badge-verdict ${vClass}">${r.verdict}</span></td>
            <td>${r.outcome || '---'}</td>
            <td>${r.iv1730 ? Number(r.iv1730).toFixed(2) + '%' : '---'}</td>
            <td>${r.ivNyOpen ? Number(r.ivNyOpen).toFixed(2) + '%' : '---'}</td>
            <td>${r.ivExit ? Number(r.ivExit).toFixed(2) + '%' : '---'}</td>
            <td>${r.speedVsIv ? r.speedVsIv : '---'}</td>
            <td style="max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${r.notes || '---'}
            </td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load nights:', err);
  }
}

/**
 * Loads technical drawings & anchors
 */
async function loadDrawings() {
  try {
    const res = await fetch('/api/v1/drawings');
    const json = await res.json();
    const tbody = document.getElementById('drawings-tbody');
    if (!tbody || !json.success) return;

    tbody.innerHTML = json.data
      .slice(0, 5)
      .map((d: any) => `
        <tr>
          <td>${d.label || 'Drawing'}</td>
          <td>${d.drawingType}</td>
          <td>${d.points?.[0]?.price ? '$' + Number(d.points[0].price).toLocaleString() : '---'}</td>
        </tr>
      `)
      .join('');
  } catch (err) {
    console.error('Failed to load drawings:', err);
  }
}

/**
 * Loads options flow buckets
 */
async function loadFlow() {
  try {
    const res = await fetch('/api/v1/market/flow?limit=5');
    const json = await res.json();
    const tbody = document.getElementById('flow-tbody');
    if (!tbody || !json.success) return;

    tbody.innerHTML = json.data
      .map((f: any) => {
        const tStr = new Date(f.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
          <tr>
            <td>${tStr}</td>
            <td style="color: #34d399;">${Number(f.callBuyVol).toFixed(2)}</td>
            <td style="color: #f87171;">${Number(f.putBuyVol).toFixed(2)}</td>
            <td>${f.tradeCount}</td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load flow:', err);
  }
}

/**
 * Polls live 24/7 background worker state
 */
async function pollWorkerStatus() {
  try {
    const res = await fetch('/api/v1/market/status');
    const json = await res.json();
    if (!json.success || !json.workers) return;

    const w = json.workers;
    const spot = w.binance?.spotPrice || w.deltaIndia?.spotPrice;
    const dvol = w.deribit?.currentDvol;
    const mark = w.deltaIndia?.markPrice;

    if (spot) {
      const spotEl = document.getElementById('ticker-spot');
      const curSpotEl = document.getElementById('strangle-current-spot');
      if (spotEl) spotEl.innerHTML = `<span class="status-indicator"></span> $${spot.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      if (curSpotEl) curSpotEl.innerText = `$${spot.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    }

    if (dvol) {
      const dvolEl = document.getElementById('ticker-dvol');
      if (dvolEl) dvolEl.innerText = `${dvol.toFixed(2)}%`;
    }

    if (mark) {
      const markEl = document.getElementById('ticker-mark');
      if (markEl) markEl.innerText = `$${mark.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    }
  } catch (err) {
    // Non-blocking status poll
  }
}

/**
 * Triggers test alert through Fastify backend
 */
async function sendTestAlert() {
  try {
    const res = await fetch('/api/v1/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'ntfy' }),
    });
    const json = await res.json();
    if (json.success) {
      alert(`Push Notification Dispatched!\nView live at: ${json.ntfyUrl}`);
    }
  } catch (err) {
    alert('Failed to dispatch alert.');
  }
}

// Bootstrap Application
renderApp();
