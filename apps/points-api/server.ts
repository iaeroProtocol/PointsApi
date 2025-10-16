// apps/points-api/server.ts
import 'dotenv/config';
import { build } from './routes';
import crypto from 'crypto';
import fastifyRawBody from 'fastify-raw-body';

const port = Number(process.env.PORT ?? 8080);
const host = '0.0.0.0';
const ZEALY_SECRET = process.env.ZEALY_SECRET ?? ''; // set in Railway

function verifyZealySignature(req: any, raw: Buffer | string) {
  // If you prefer to reject when secret is missing, replace with: if (!ZEALY_SECRET) return false;
  if (!ZEALY_SECRET) return true;

  const sig = req.headers['x-zealy-signature'];
  if (typeof sig !== 'string' || !sig.length) return false;

  const body = typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '';
  const hmac = crypto.createHmac('sha256', ZEALY_SECRET);
  hmac.update(body, 'utf8');
  const digest = `sha256=${hmac.digest('hex')}`;

  const a = Buffer.from(digest);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false; // avoid throwing
  return crypto.timingSafeEqual(a, b);
}

async function main() {
  const app = await build();

  // Make rawBody available ONLY on /webhooks/zealy
  await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
    routes: ['/webhooks/zealy'],
  });

  // Signature guard
  app.addHook('preValidation', async (req, reply) => {
    if (req.url.startsWith('/webhooks/zealy')) {
      const raw = (req as any).rawBody ?? '';
      if (!verifyZealySignature(req, raw)) {
        return reply.code(401).send({ ok: false, error: 'bad signature' });
      }
    }
  });

  // Webhook endpoint for Zealy automations
  app.post('/webhooks/zealy', async (req, reply) => {
    const payload = req.body as any;
    // TODO: handle the specific Zealy event types you care about
    // e.g., enqueue job, upsert bonus table, etc.
    return { ok: true };
  });

  // Existing endpoint
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

