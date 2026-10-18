import dotenv from 'dotenv';
import { buildServer } from './server.js';

dotenv.config();

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
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

main();
