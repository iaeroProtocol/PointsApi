import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

// ---------- DB setup ----------
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------- helpers ----------
const WEI = 10n ** 18n;

// Convert wei-days → "token-days" string with 18 decimals
function toPointsDec(weiDays: bigint) {
  const q = weiDays / WEI;
  const r = weiDays % WEI;
  const frac = r.toString().padStart(18, '0'); // 18 dp, same as leaderboard
  return `${q}.${frac}`;
}
function toBalanceDec(wei: string | number | bigint) {
  const val = BigInt(wei);
  const scale = 10n ** 18n;
  const int = val / scale;
  const rem = val % scale;
  // format as "123.456..." with 18 decimal places
  return `${int}.${rem.toString().padStart(18, '0')}`;
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

      // ---- points: same unit as leaderboard (token-days with 18 decimals) ----
      const weiDays = BigInt(r.points_wei_days as any);
      const points = toPointsDec(weiDays);

      // ---- rank: from leaderboard ----
      const lb = await pool.query(
        `
        WITH ranked AS (
          SELECT address, DENSE_RANK() OVER (ORDER BY points DESC) AS rnk
          FROM staking_points_leaderboard
        )
        SELECT rnk AS rank
        FROM ranked
        WHERE address = $1
        `,
        [buf]
      );
      const rank = lb.rowCount ? Number(lb.rows[0].rank) : null;

      return {
        address,
        points,                                   // token-days (matches leaderboard)
        lastBalance: r.last_balance,             // raw wei
        totalStaked: toBalanceDec(r.last_balance), // NEW: human-readable tokens
        lastTimestamp: Number(r.last_ts),
        rank,
      };
    }
  );

  
  

  // ---------- /leaderboard (UPDATED with Sort) ----------
  // Add sort to the query type
  type LeaderboardQuery = { limit?: string | number; sort?: string };

  app.get<{ Querystring: LeaderboardQuery }>(
    '/leaderboard',
    async (req: FastifyRequest<{ Querystring: LeaderboardQuery }>) => {
      const limit = Math.min(Number(req.query?.limit ?? 100), 1000);
      
      // Determine sort mode: 'points' (default) or 'staked'
      const sortMode = req.query.sort === 'staked' ? 'staked' : 'points';

      // Dynamic SQL generation
      // 1. If sorting by staked, we rank/order by wallet balance (w.last_balance)
      // 2. If sorting by points, we rank/order by leaderboard points (l.points)
      const orderByClause = sortMode === 'staked' 
        ? 'w.last_balance DESC' 
        : 'l.points DESC';

      const q = await pool.query(
        `
        SELECT
          encode(l.address, 'hex') AS address,
          l.points,
          w.last_balance,
          DENSE_RANK() OVER (ORDER BY ${orderByClause}) AS rank
        FROM staking_points_leaderboard l
        JOIN staking_points_wallet w ON l.address = w.address
        ORDER BY ${orderByClause}, l.address
        LIMIT $1
        `,
        [limit]
      );

      return q.rows.map((r: { address: string; points: string; last_balance: string; rank: string | number }) => ({
        address: '0x' + r.address,
        points: r.points,
        totalStaked: toBalanceDec(r.last_balance),
        rank: Number(r.rank),
      }));
    }
  );

  // ---------- /sync/zealy (NEW) ----------
  app.post('/sync/zealy', async (req: FastifyRequest, reply: FastifyReply) => {
    requireAdmin(req); // Only accessible with ZEALY_ADMIN_SECRET header
    
    // 1. Get all wallets linked to Zealy
    const links = await pool.query(`
      SELECT
        t1.address,
        t1.zealy_user_id,
        COALESCE(t2.last_points_synced, 0) AS last_points_synced,
        t3.points AS current_points
      FROM zealy_user_links t1
      LEFT JOIN zealy_xp_sync t2 ON t1.address = t2.address
      JOIN staking_points_leaderboard t3 ON t1.address = t3.address
      -- Only sync users who have more points than last time
      WHERE t3.points > COALESCE(t2.last_points_synced, 0)
    `);

    const results: { synced: number, skipped: number, errors: number, details: any[] } = {
      synced: 0,
      skipped: 0,
      errors: 0,
      details: []
    };

    // 2. Process each wallet
    for (const row of links.rows) {
      const zealyId = row.zealy_user_id;
      const currentPoints = parseFloat(row.current_points);
      const lastSynced = parseFloat(row.last_points_synced);
      
      // Calculate the difference (XP to push)
      const diffPoints = Math.floor(currentPoints - lastSynced);
      
      // Skip if somehow <= 0 (should be caught by WHERE clause but defensive)
      if (diffPoints <= 0) {
        results.skipped++;
        continue;
      }
      
      const hexAddress = '0x' + row.address.toString('hex');
      
      try {
        // 3. Push XP to Zealy
        await pushXP(zealyId, diffPoints, `Staking Points Sync (${hexAddress})`);
        
        // 4. Update the last synced amount in DB
        await pool.query(
          `
          INSERT INTO zealy_xp_sync (address, last_points_synced, updated_at)
          VALUES ($1, $2, now())
          ON CONFLICT (address) DO UPDATE SET
            last_points_synced = $2,
            updated_at = now()
          `,
          [row.address, currentPoints.toFixed(18)] // Use full precision for tracking
        );
        
        results.synced++;
        results.details.push({
          zealyId,
          pointsPushed: diffPoints,
          status: 'success'
        });

      } catch (e: any) {
        results.errors++;
        results.details.push({
          zealyId,
          pointsPushed: diffPoints,
          status: 'error',
          message: e.message || 'Unknown error'
        });
        console.error(`[zealy-sync] Error pushing XP for ${zealyId}:`, e.message);
      }
    }
    
    return results;
  });

  // ---------- /zealy/link (NEW) ----------
  type LinkBody = { address: string, zealyUserId: string };
  app.post<{ Body: LinkBody }>(
    '/zealy/link',
    async (req: FastifyRequest<{ Body: LinkBody }>, reply: FastifyReply) => {
      const { address, zealyUserId } = req.body;
      if (!address || !zealyUserId) {
        return reply.code(400).send({ error: 'Missing address or zealyUserId' });
      }

      try {
        await pool.query(
          `
          INSERT INTO zealy_user_links (zealy_user_id, address, linked_at)
          VALUES ($1, decode($2, 'hex'), now())
          ON CONFLICT (zealy_user_id) DO UPDATE SET
            address = decode($2, 'hex'),
            linked_at = now()
          ON CONFLICT (address) DO UPDATE SET
            zealy_user_id = $1,
            linked_at = now()
          `,
          [zealyUserId, address.replace(/^0x/, '')]
        );
        return { ok: true };
      } catch (e: any) {
        console.error('Zealy link failed:', e.message);
        return reply.code(500).send({ error: 'Database link failed' });
      }
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
