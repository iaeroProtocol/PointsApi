// apps/points-api/routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------- helpers ----------
function toPointsDec(weiSeconds: bigint) {
  const scale = 10n ** 18n * 86400n; // 1e18 * seconds/day
  const int = weiSeconds / scale;
  const rem = weiSeconds % scale;
  const frac = (rem * 10_000_000n) / scale; // 7 dp
  return `${int}.${frac.toString().padStart(7, '0')}`;
}
function toHex(buf: Buffer) {
  return '0x' + buf.toString('hex');
}

// ---------- tiny types ----------
type AddressParams = { address: string };
type LimitQuery = { limit?: string | number };
type LimitOffsetQuery = { limit?: string | number; offset?: string | number };
type VerifyQuery = { min?: string | number };

export async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // plugins
  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? '*').split(','),
    methods: ['GET'],
  });
  // await app.register(rateLimit, {
  //   max: Number(process.env.RATE_LIMIT_PER_MIN ?? 600),
  //   timeWindow: '1 minute',
  // });

  // ---------- routes ----------
  app.get('/health', async () => ({ ok: true }));

  app.get<{
    Params: AddressParams;
  }>('/points/:address', async (req: FastifyRequest<{ Params: AddressParams }>, rep: FastifyReply) => {
    const address = req.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return rep.code(400).send({ error: 'bad_address' });
    }
    const buf = Buffer.from(address.slice(2), 'hex');
    const q = await pool.query(
      `SELECT last_balance, last_ts, points_wei_days
         FROM staking_points_wallet
        WHERE address=$1`,
      [buf],
    );
    const rowCount = q.rowCount ?? 0;
    if (rowCount === 0) return rep.code(404).send({ error: 'not_found' });
    const r = q.rows[0] as {
      last_balance: string | number | bigint;
      last_ts: string | number | bigint;
      points_wei_days: string | number | bigint;
    };
    return {
      address,
      points: toPointsDec(BigInt(r.points_wei_days)),
      lastBalance: r.last_balance,
      lastTimestamp: Number(r.last_ts),
    };
  });

  app.get<{
    Querystring: LimitQuery;
  }>('/leaderboard', async (req: FastifyRequest<{ Querystring: LimitQuery }>) => {
    const limit = Math.min(Number(req.query?.limit ?? 100), 1000);
    const q = await pool.query(
      `SELECT address, points
         FROM staking_points_leaderboard
        ORDER BY rank ASC
        LIMIT $1`,
      [limit],
    );
    return q.rows.map((r: { address: Buffer; points: string }) => ({
      address: toHex(r.address),
      points: r.points,
    }));
  });

  app.get<{
    Params: AddressParams;
  }>('/claimed/:address', async (req: FastifyRequest<{ Params: AddressParams }>, rep: FastifyReply) => {
    const address = req.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return rep.code(400).send({ error: 'bad_address' });
    }
    const buf = Buffer.from(address.slice(2), 'hex');

    const s = await pool.query(
      `SELECT first_ts, last_ts, claim_count, total_wei
         FROM staking_claimers
        WHERE address=$1`,
      [buf],
    );
    if ((s.rowCount ?? 0) === 0) return rep.code(404).send({ claimed: false });

    const r = await pool.query(
      `SELECT tx_hash, log_index, amount_wei, block_num, ts
         FROM staking_claims
        WHERE address=$1
        ORDER BY block_num DESC, log_index DESC
        LIMIT 50`,
      [buf],
    );
    return {
      claimed: true,
      summary: {
        firstTimestamp: Number(s.rows[0].first_ts),
        lastTimestamp: Number(s.rows[0].last_ts),
        claimCount: Number(s.rows[0].claim_count),
        totalAmountWei: s.rows[0].total_wei,
      },
      recent: r.rows.map((x: {
        tx_hash: Buffer; log_index: number; amount_wei: string | number | bigint; block_num: string | number | bigint; ts: string | number | bigint;
      }) => ({
        txHash: toHex(x.tx_hash),
        logIndex: x.log_index,
        amountWei: x.amount_wei,
        blockNumber: Number(x.block_num),
        timestamp: Number(x.ts),
      })),
    };
  });

  app.get<{
    Querystring: LimitOffsetQuery;
  }>('/claimed', async (req: FastifyRequest<{ Querystring: LimitOffsetQuery }>) => {
    const limit = Math.min(Number(req.query?.limit ?? 100), 1000);
    const offset = Math.max(Number(req.query?.offset ?? 0), 0);
    const q = await pool.query(
      `SELECT address, first_ts, last_ts, claim_count, total_wei
         FROM staking_claimers
        ORDER BY last_ts DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return q.rows.map((r: {
      address: Buffer; first_ts: string | number | bigint; last_ts: string | number | bigint; claim_count: string | number | bigint; total_wei: string | number | bigint;
    }) => ({
      address: toHex(r.address),
      firstTimestamp: Number(r.first_ts),
      lastTimestamp: Number(r.last_ts),
      claimCount: Number(r.claim_count),
      totalAmountWei: r.total_wei,
    }));
  });

  app.get<{
    Params: AddressParams; Querystring: VerifyQuery;
  }>('/verify-zealy/:address', async (req: FastifyRequest<{ Params: AddressParams; Querystring: VerifyQuery }>) => {
    const address = req.params.address.toLowerCase();
    const min = Number(req.query?.min ?? 0);
    const buf = Buffer.from(address.slice(2), 'hex');
    const q = await pool.query(
      `SELECT points_wei_days FROM staking_points_wallet WHERE address=$1`,
      [buf],
    );
    if ((q.rowCount ?? 0) === 0) return { ok: false, reason: 'not_found' as const };
    const ptsStr = toPointsDec(BigInt(q.rows[0].points_wei_days));
    // Compare as number (string may be fine for display)
    return { ok: Number(ptsStr) >= min, points: ptsStr };
  });

  app.get<{
    Params: AddressParams;
  }>('/verify-zealy-claimed/:address', async (req: FastifyRequest<{ Params: AddressParams }>) => {
    const address = req.params.address.toLowerCase();
    const buf = Buffer.from(address.slice(2), 'hex');
    const q = await pool.query(
      `SELECT 1 FROM staking_claimers WHERE address=$1`,
      [buf],
    );
    return { ok: (q.rowCount ?? 0) > 0 };
  });

  return app;
}
