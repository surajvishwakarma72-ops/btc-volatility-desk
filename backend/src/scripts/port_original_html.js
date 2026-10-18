import fs from 'node:fs';

const origHtml = fs.readFileSync('../Volatility Desk.html', 'utf8');

// Inject our API Sync Bridge right after <head>
const apiBridgeScript = `
<script id="backendSyncBridge">
(function() {
  console.log('[BackendBridge] Initializing synchronization with Fastify backend on port 4000...');

  // Auto-sync data from PostgreSQL into browser storage on initial boot
  async function syncFromBackend() {
    try {
      // 1. Sync User Preferences
      const prefRes = await fetch('/api/v1/preferences');
      if (prefRes.ok) {
        const prefData = await prefRes.json();
        if (prefData.success && prefData.data) {
          const p = prefData.data;
          if (p.activeIndicators) localStorage.setItem('v132_ind', JSON.stringify(p.activeIndicators));
          if (p.theme === 'classic_light') localStorage.setItem('v143_skin', '0');
          if (p.chartLayout?.viewPreferences) {
            for (const [k, v] of Object.entries(p.chartLayout.viewPreferences)) {
              if (v !== undefined) localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
          }
        }
      }

      // 2. Sync Trades
      const tradeRes = await fetch('/api/v1/trades');
      if (tradeRes.ok) {
        const tradeData = await tradeRes.json();
        if (tradeData.success && Array.isArray(tradeData.data)) {
          localStorage.setItem('v99_trades', JSON.stringify(tradeData.data));
        }
      }

      // 3. Sync Nightly Reviews
      const nightRes = await fetch('/api/v1/nights?limit=500');
      if (nightRes.ok) {
        const nightData = await nightRes.json();
        if (nightData.success && Array.isArray(nightData.data)) {
          localStorage.setItem('v147_nights', JSON.stringify(nightData.data));
        }
      }

      // 4. Sync Chart Drawings
      const drawRes = await fetch('/api/v1/drawings');
      if (drawRes.ok) {
        const drawData = await drawRes.json();
        if (drawData.success && Array.isArray(drawData.data)) {
          localStorage.setItem('btc_drawings_v1', JSON.stringify(drawData.data));
        }
      }

      console.log('[BackendBridge] Initial PostgreSQL hydration complete.');
    } catch (err) {
      console.warn('[BackendBridge] Offline or backend unreachable, using cached state:', err);
    }
  }

  // Run initial sync before DOM renders
  syncFromBackend();
})();
</script>
`;

let newHtml = origHtml;
if (newHtml.includes('<head>')) {
  newHtml = newHtml.replace('<head>', '<head>\n' + apiBridgeScript);
} else {
  newHtml = apiBridgeScript + '\n' + newHtml;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetPath = path.resolve(__dirname, '../../../../frontend/index.html');
// Note: __dirname is backend/src/scripts, so ../../../ is BTC Volatility Desk, then frontend/index.html
const frontendIndexPath = path.resolve(__dirname, '../../../frontend/index.html');

fs.writeFileSync(frontendIndexPath, newHtml, 'utf8');
console.log('Successfully ported Volatility Desk.html into ' + frontendIndexPath + ' with Backend Sync Bridge!');
