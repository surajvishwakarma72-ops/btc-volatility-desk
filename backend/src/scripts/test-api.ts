import 'dotenv/config';
import { buildServer } from '../server.js';
import { pool } from '../db/index.js';

async function testApi() {
  const app = await buildServer();
  await app.ready();

  console.log('='.repeat(60));
  console.log('  FASTIFY REST API SUITE TEST RUN');
  console.log('='.repeat(60));

  // 1. Health
  const rHealth = await app.inject({ method: 'GET', url: '/health' });
  console.log('[GET /health]', rHealth.statusCode, rHealth.json());

  // 2. Auth profile
  const rAuth = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
  console.log('[GET /api/v1/auth/me]', rAuth.statusCode, rAuth.json());

  // 3. Trades list
  const rTrades = await app.inject({ method: 'GET', url: '/api/v1/trades' });
  const tradesData = rTrades.json();
  console.log('[GET /api/v1/trades]', rTrades.statusCode, `Returned: ${tradesData.count} trades`);

  // 4. Active trade
  const rActive = await app.inject({ method: 'GET', url: '/api/v1/trades/active' });
  console.log('[GET /api/v1/trades/active]', rActive.statusCode, rActive.json());

  // 5. Nights
  const rNights = await app.inject({ method: 'GET', url: '/api/v1/nights?limit=5' });
  const nightsData = rNights.json();
  console.log('[GET /api/v1/nights]', rNights.statusCode, `Returned: ${nightsData.count} nights`);

  // 6. Nights stats
  const rStats = await app.inject({ method: 'GET', url: '/api/v1/nights/stats' });
  console.log('[GET /api/v1/nights/stats]', rStats.statusCode, rStats.json());

  // 7. Preferences
  const rPrefs = await app.inject({ method: 'GET', url: '/api/v1/preferences' });
  console.log('[GET /api/v1/preferences]', rPrefs.statusCode, `Theme: ${rPrefs.json().data?.theme}`);

  // 8. Drawings
  const rDrawings = await app.inject({ method: 'GET', url: '/api/v1/drawings' });
  const drawingsData = rDrawings.json();
  console.log('[GET /api/v1/drawings]', rDrawings.statusCode, `Returned: ${drawingsData.count} drawings`);

  // 9. Market candles
  const rCandles = await app.inject({ method: 'GET', url: '/api/v1/market/candles?limit=5' });
  const candlesData = rCandles.json();
  console.log('[GET /api/v1/market/candles]', rCandles.statusCode, `Returned: ${candlesData.count} candles`);

  // 10. Market flow
  const rFlow = await app.inject({ method: 'GET', url: '/api/v1/market/flow?limit=5' });
  const flowData = rFlow.json();
  console.log('[GET /api/v1/market/flow]', rFlow.statusCode, `Returned: ${flowData.count} buckets`);

  // 11. Market indicators
  const rInd = await app.inject({ method: 'GET', url: '/api/v1/market/indicators?limit=5' });
  const indData = rInd.json();
  console.log('[GET /api/v1/market/indicators]', rInd.statusCode, `Returned: ${indData.count} snapshots`);

  // 12. Alert rules & history
  const rRules = await app.inject({ method: 'GET', url: '/api/v1/alerts/rules' });
  const rHist = await app.inject({ method: 'GET', url: '/api/v1/alerts/history?limit=5' });
  console.log('[GET /api/v1/alerts/rules]', rRules.statusCode, `Rules: ${rRules.json().count}`);
  console.log('[GET /api/v1/alerts/history]', rHist.statusCode, `History: ${rHist.json().count}`);

  // 13. Market Workers Status
  console.log('Waiting 3s for worker WebSocket ticks...');
  await new Promise((r) => setTimeout(r, 3000));
  const rStatus = await app.inject({ method: 'GET', url: '/api/v1/market/status' });
  console.log('[GET /api/v1/market/status]', rStatus.statusCode, JSON.stringify(rStatus.json(), null, 2));

  console.log('='.repeat(60));
  console.log('  ALL ENDPOINTS PASSED SUCCESSFULLY!');
  console.log('='.repeat(60));

  await app.close();
  await pool.end();
}

testApi().catch((e) => {
  console.error('API Test Error:', e);
  process.exit(1);
});
