// apps/points-api/routes.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
// import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// helpers
function toPointsDec(weiSeconds: bigint) {
  const scale = 10n ** 18n * 86400n;
  const int = weiSeconds / scale;
  const rem = weiSeconds % scale;
  const frac = (rem * 10_000_000n) / scale; // 7dp
  return `${int}.${frac.toString().padStart(7, '0')}`;
}
function toHex(buf: Buffer) {
  return '0x' + buf.toString('hex');
}

export async function build() {
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

  // routes
  app.get('/health', async () => ({ ok: true }));

  app.get('/points/:address', async (req, rep) => {
    const address = (req.params as any).address.toLowerCase();
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
    if (q.rowCount === 0) return rep.code(404).send({ error: 'not_found' });
    const r = q.rows[0];
    return {
      address,
      points: toPointsDec(BigInt(r.points_wei_days)),
      lastBalance: r.last_balance,
      lastTimestamp: Number(r.last_ts),
    };
  });

  app.get('/leaderboard', async (req) => {
    const limit = Math.min(Number((req.query as any).limit ?? 100), 1000);
    const q = await pool.query(
      `SELECT address, points
         FROM staking_points_leaderboard
        ORDER BY rank ASC
        LIMIT $1`,
      [limit],
    );
    return q.rows.map((r: any) => ({
      address: toHex(r.address),
      points: r.points,
    }));
  });

  app.get('/claimed/:address', async (req, rep) => {
    const address = (req.params as any).address.toLowerCase();
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
    if (s.rowCount === 0) return rep.code(404).send({ claimed: false });

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
      recent: r.rows.map((x: any) => ({
        txHash: toHex(x.tx_hash),
        logIndex: x.log_index,
        amountWei: x.amount_wei,
        blockNumber: Number(x.block_num),
        timestamp: Number(x.ts),
      })),
    };
  });

  app.get('/claimed', async (req) => {
    const limit = Math.min(Number((req.query as any).limit ?? 100), 1000);
    const offset = Math.max(Number((req.query as any).offset ?? 0), 0);
    const q = await pool.query(
      `SELECT address, first_ts, last_ts, claim_count, total_wei
         FROM staking_claimers
        ORDER BY last_ts DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return q.rows.map((r: any) => ({
      address: toHex(r.address),
      firstTimestamp: Number(r.first_ts),
      lastTimestamp: Number(r.last_ts),
      claimCount: Number(r.claim_count),
      totalAmountWei: r.total_wei,
    }));
  });

  app.get('/verify-zealy/:address', async (req) => {
    const address = (req.params as any).address.toLowerCase();
    const min = Number((req.query as any).min ?? 0);
    const buf = Buffer.from(address.slice(2), 'hex');
    const q = await pool.query(
      `SELECT points_wei_days FROM staking_points_wallet WHERE address=$1`,
      [buf],
    );
    if (q.rowCount === 0) return { ok: false, reason: 'not_found' };
    const pts = toPointsDec(BigInt(q.rows[0].points_wei_days));
    return { ok: Number(pts) >= min, points: pts };
  });

  app.get('/verify-zealy-claimed/:address', async (req) => {
    const address = (req.params as any).address.toLowerCase();
    const buf = Buffer.from(address.slice(2), 'hex');
    const q = await pool.query(
      `SELECT 1 FROM staking_claimers WHERE address=$1`,
      [buf],
    );
    return { ok: q.rowCount > 0 };
  });

  return app;
}
