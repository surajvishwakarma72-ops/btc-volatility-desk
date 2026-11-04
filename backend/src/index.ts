import dotenv from 'dotenv';
import { buildServer } from './server.js';
import { startDeltaFeed } from './services/delta-feed.js';
import { isConnectFailure } from './db/index.js';

dotenv.config();

// Background workers run without a caller, so a failed database connection in any of them arrives here. Node's default would stop
// the whole server, taking the stop alarm and exit management with it, so an outage is logged and the workers retry on their next
// tick. Anything else is a real bug and still stops the process.
process.on('unhandledRejection', (reason) => {
  const code = (reason as { code?: string } | null)?.code;
  if (isConnectFailure(reason) || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === '53000' || code === 'XX000') {
    console.error('[server] database unreachable, continuing:', reason instanceof Error ? reason.message : reason);
    return;
  }
  throw reason;
});

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Main Process Entrypoint
 */
async function main() {
  try {
    const server = await buildServer();

    await server.listen({ port: PORT, host: HOST });
    server.log.info(`Volatility Desk backend server listening on http://${HOST}:${PORT}`);

    // Delta Exchange Live Feed (Task T4.4)
    startDeltaFeed({
      baseUrl: `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`,
    });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

main();
