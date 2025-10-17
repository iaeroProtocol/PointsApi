import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

// ---------- DB setup ----------
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

function requireAdmin(req: FastifyRequest) {
  const hdr = String(req.headers['authorization'] || '');
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (tok !== process.env.ZEALY_ADMIN_SECRET) {
    const err: any = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

// Node 18+ has global fetch; no import needed
async function pushXP(zealyUserId: string, amount: number, reason: string) {
  const sub = process.env.ZEALY_SUBDOMAIN!;
  const key = process.env.ZEALY_ADMIN_API_KEY!;
  const url = `https://api-v2.zealy.io/public/communities/${encodeURIComponent(
    sub
  )}/users/${encodeURIComponent(zealyUserId)}/xp`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, reason }),
  });

  if (!res.ok) {
    throw new Error(
      `Zealy XP push failed (${res.status}): ${await res.text().catch(() => '')}`
    );
  }
}

// ---------- env ----------
const INDEXER_HEALTH =
  process.env.INDEXER_HEALTH ||
  process.env.INDEXER_HEALTH_URL ||
  '';

// ---------- tiny types ----------
type AddressParams = { address: string };
type LimitQuery = { limit?: string | number };
type LimitOffsetQuery = { limit?: string | number; offset?: string | number };
type VerifyQuery = { min?: string | number };

// ---------- build ----------
export async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // plugins
  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? '*').split(','),
    methods: ['GET'],
  });

  // ---------- /health (indexer proxy + DB fallback) ----------
  app.get('/health', async (_req, rep) => {
    const checkpointFromDb = async (): Promise<string | null> => {
      try {
        const r = await pool.query(
          'SELECT last_block FROM indexing_checkpoint LIMIT 1'
        );
        return r.rowCount ? String(r.rows[0].last_block) : null;
      } catch {
        return null;
      }
    };

    try {
      if (INDEXER_HEALTH) {
        const r = await fetch(INDEXER_HEALTH, { method: 'GET' });
        if (r.ok) {
          const j = (await r.json()) as Partial<{
            chainId: number;
            head: string | number;
            checkpoint: string | number;
            lag: number;
            targets: string[];
          }>;
          

          return rep.send({
            ok: true,
            name: 'iaero-points-api',
            source: 'indexer',
            chainId: j.chainId ?? null,
            head: j.head ?? null,
            checkpoint: j.checkpoint ?? null,
            lag: j.lag ?? null,
            targets: Array.isArray(j.targets) ? j.targets : [],
          });
        }
      }

      // DB fallback
      const checkpoint = await checkpointFromDb();
      return rep.send({
        ok: true,
        name: 'iaero-points-api',
        source: 'db',
        chainId: null,
        head: null,
        checkpoint,
        lag: null,
        targets: [],
        note: 'indexer health unavailable; using DB checkpoint only',
      });
    } catch (e: any) {
      const checkpoint = await checkpointFromDb();
      return rep.code(200).send({
        ok: true,
        name: 'iaero-points-api',
        source: 'error-db',
        chainId: null,
        head: null,
        checkpoint,
        lag: null,
        targets: [],
        note: `health error: ${String(e?.message || e)}; checkpoint from DB`,
      });
    }
  });

  // ---------- /points/:address ----------
  app.get<{ Params: AddressParams }>(
    '/points/:address',
    async (req: FastifyRequest<{ Params: AddressParams }>, rep: FastifyReply) => {
      const address = req.params.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return rep.code(400).send({ error: 'bad_address' });
      }
      const buf = Buffer.from(address.slice(2), 'hex');
      const q = await pool.query(
        `SELECT last_balance, last_ts, points_wei_days
           FROM staking_points_wallet
          WHERE address=$1`,
        [buf]
      );
      if (q.rowCount === 0) return rep.code(404).send({ error: 'not_found' });
      const r = q.rows[0] as {
        last_balance: string | number | bigint;
        last_ts: string | number | bigint;
        points_wei_days: string | number | bigint;
      };
      const lb = await pool.query(
        `SELECT rank, points FROM staking_points_leaderboard WHERE address = $1`,
        [buf]
      );
      const rank = lb.rowCount ? Number(lb.rows[0].rank) : null;
      
      return {
        address,
        points: toPointsDec(BigInt(r.points_wei_days)),
        lastBalance: r.last_balance,
        lastTimestamp: Number(r.last_ts),
        rank, // 👈 NEW
      };
    }
  );

  // ---------- /leaderboard ----------
  app.get<{ Querystring: LimitQuery }>(
    '/leaderboard',
    async (req: FastifyRequest<{ Querystring: LimitQuery }>) => {
      const limit = Math.min(Number(req.query?.limit ?? 100), 1000);
      const q = await pool.query(
        `SELECT address, points
           FROM staking_points_leaderboard
          ORDER BY rank ASC
          LIMIT $1`,
        [limit]
      );
      return q.rows.map((r: { address: Buffer; points: string }) => ({
        address: toHex(r.address),
        points: r.points,
      }));
    }
  );

  // ---------- /claimed/:address ----------
  app.get<{ Params: AddressParams }>(
    '/claimed/:address',
    async (req: FastifyRequest<{ Params: AddressParams }>, rep: FastifyReply) => {
      const address = req.params.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        return rep.code(400).send({ error: 'bad_address' });
      }
      const buf = Buffer.from(address.slice(2), 'hex');

      const s = await pool.query(
        `SELECT first_ts, last_ts, claim_count, total_wei
           FROM staking_claimers
          WHERE address=$1`,
        [buf]
      );
      if ((s.rowCount ?? 0) === 0) return rep.code(404).send({ claimed: false });

      const r = await pool.query(
        `SELECT tx_hash, log_index, amount_wei, block_num, ts
           FROM staking_claims
          WHERE address=$1
          ORDER BY block_num DESC, log_index DESC
          LIMIT 50`,
        [buf]
      );
      return {
        claimed: true,
        summary: {
          firstTimestamp: Number(s.rows[0].first_ts),
          lastTimestamp: Number(s.rows[0].last_ts),
          claimCount: Number(s.rows[0].claim_count),
          totalAmountWei: s.rows[0].total_wei,
        },
        recent: r.rows.map(
          (x: {
            tx_hash: Buffer;
            log_index: number;
            amount_wei: string | number | bigint;
            block_num: string | number | bigint;
            ts: string | number | bigint;
          }) => ({
            txHash: toHex(x.tx_hash),
            logIndex: x.log_index,
            amountWei: x.amount_wei,
            blockNumber: Number(x.block_num),
            timestamp: Number(x.ts),
          })
        ),
      };
    }
  );

  // ---------- /meta (table counts) ----------
  app.get('/meta', async () => {
    const q = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM staking_points_wallet)      AS wallets,
        (SELECT COUNT(*) FROM staking_points_daily)       AS daily,
        (SELECT COUNT(*) FROM staking_points_leaderboard) AS leaderboard,
        (SELECT COUNT(*) FROM staking_claims)             AS claims,
        (SELECT COUNT(*) FROM staking_claimers)           AS claimers
    `);
    const r = q.rows[0] || {};
    return {
      wallets: Number(r.wallets || 0),
      daily: Number(r.daily || 0),
      leaderboard: Number(r.leaderboard || 0),
      claims: Number(r.claims || 0),
      claimers: Number(r.claimers || 0),
    };
  });

  return app;
}
