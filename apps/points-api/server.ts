// apps/points-api/server.ts
import 'dotenv/config';
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { build } from './routes.js';
import crypto from 'node:crypto';
// If this plugin is missing/incompatible, we won't crash on startup.
let fastifyRawBody: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fastifyRawBody = (await import('fastify-raw-body')).default ?? (await import('fastify-raw-body'));
} catch {
  fastifyRawBody = null;
}

const port = Number(process.env.PORT ?? 8080);
const host = '0.0.0.0';
const ZEALY_SECRET = process.env.ZEALY_SECRET ?? ''; // set in Railway

function verifyZealySignature(req: FastifyRequest, raw: Buffer | string): boolean {
  if (!ZEALY_SECRET) return true;
  const sigHeader = req.headers['x-zealy-signature'];
  if (typeof sigHeader !== 'string' || !sigHeader.length) return false;

  const body = typeof raw === 'string' ? raw : raw?.toString('utf8') ?? '';
  const hmac = crypto.createHmac('sha256', ZEALY_SECRET);
  hmac.update(body, 'utf8');
  const digest = `sha256=${hmac.digest('hex')}`;

  const a = Buffer.from(digest);
  const b = Buffer.from(sigHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function main() {
  const app: FastifyInstance = await build();

  // Best-effort rawBody: won’t block startup if the plugin isn’t available/compatible
  if (fastifyRawBody) {
    try {
      await app.register(fastifyRawBody as unknown as any, {
        field: 'rawBody',
        global: false,
        encoding: 'utf8',
        runFirst: true,
        routes: ['/webhooks/zealy'],
      });
    } catch (e) {
      app.log.warn({ err: e }, 'fastify-raw-body failed to register; continuing without rawBody');
    }
  } else {
    app.log.warn('fastify-raw-body not installed/loaded; continuing without rawBody');
  }

  // Signature guard (still works; if rawBody isn’t present we’ll verify against empty string)
  app.addHook('preValidation', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/webhooks/zealy')) {
      const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody ?? '';
      if (!verifyZealySignature(req, raw)) {
        return reply.code(401).send({ ok: false, error: 'bad_signature' });
      }
    }
  });

  // Zealy webhook (kept minimal; won’t crash if rawBody is absent)
  app.post('/webhooks/zealy', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ ok: true });
  });

  // Version endpoint
  app.get('/version', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.send({ name: 'iaero-points-api', port, env: process.env.NODE_ENV ?? 'production' });
  });

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
