// apps/points-api/server.ts
import 'dotenv/config';
import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { build } from './routes.js'; // if you're ESM/NodeNext. If CJS, drop the .js
import crypto from 'node:crypto';

const port = Number(process.env.PORT ?? 8080);
const host = '0.0.0.0';
const ZEALY_SECRET = process.env.ZEALY_SECRET ?? ''; // set in Railway

function verifyZealySignature(req: FastifyRequest, raw: Buffer | string): boolean {
  if (!ZEALY_SECRET) return true; // allow if not configured
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

  // Minimal health (keep only here OR only in routes.ts — not both)
  app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.code(200).send({ ok: true });
  });

  // --- Raw body support for Zealy on Fastify v4 (no plugin) ---
  // Keep raw buffer for application/json ONLY on /webhooks/zealy
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' }, // give us Buffer
    (req, body, done) => {
      // store raw buffer for signature verification
      (req as any).rawBody = body as Buffer;

      // parse JSON safely
      try {
        const parsed = body.length ? JSON.parse((body as Buffer).toString('utf8')) : {};
        done(null, parsed);
      } catch (err) {
        (err as any).statusCode = 400;
        done(err as any, undefined);
      }
    }
  );

  // Signature guard for the Zealy endpoint
  app.addHook('preValidation', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/webhooks/zealy')) {
      const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody ?? '';
      if (!verifyZealySignature(req, raw)) {
        return reply.code(401).send({ ok: false, error: 'bad_signature' });
      }
    }
  });

  // Zealy webhook (will have parsed JSON body + rawBody Buffer)
  app.post('/webhooks/zealy', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.body as Record<string, unknown> | undefined;
    // TODO: handle payload as needed
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
