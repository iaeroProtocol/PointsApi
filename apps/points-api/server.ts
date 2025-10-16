// apps/points-api/server.ts
import 'dotenv/config';
import { build } from './routes';

const port = Number(process.env.PORT ?? 8080);
const host = '0.0.0.0';

async function main() {
  const app = await build();

  app.get('/version', async () => ({
    name: 'iaero-points-api',
    port,
    env: process.env.NODE_ENV || 'development',
  }));

  try {
    const addr = await app.listen({ port, host });
    app.log.info(`API listening at ${addr}`);
    console.log(`API listening at ${addr}`);
  } catch (err) {
    app.log.error({ err }, 'Failed to start server');
    console.error(err);
    process.exit(1);
  }
}

main();
