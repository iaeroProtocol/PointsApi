// apps/points-api/routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const INDEXER_HEALTH =
  process.env.INDEXER_HEALTH ||
  process.env.INDEXER_HEALTH_URL || // optional legacy name
  '';

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
  const url = `https://api-v2.zealy.io/public/communities/${encodeURIComponent(sub)}/users/${encodeURIComponent(zealyUserId)}/xp`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, reason }),
  });

  if (!res.ok) {
    throw new Error(`Zealy XP push failed (${res.status}): ${await res.text().catch(()=>'')}`);
  }
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
  app.get('/health', async (_req, rep) => {
    // Helper to get checkpoint from DB if the indexer health isn’t available
    const checkpointFromDb = async (): Promise<string | null> => {
      try {
        const r = await pool.query('SELECT last_block FROM indexing_checkpoint LIMIT 1');
        return r.rowCount ? String(r.rows[0].last_block) : null;
      } catch {
        return null;
      }
    };
  
    try {
      if (INDEXER_HEALTH) {
        const r = await fetch(INDEXER_HEALTH, { method: 'GET' });
	  if (r.ok) {
  	    // Type guard: tell TS what to expect
  	    const j: Partial<{
    	      chainId: number;
    	      head: string | number;
              checkpoint: string | number;
    	      lag: number;
    	      targets: string[];
  	    }> = await r.json();

  	    return rep.send({
    	      ok: true,
   	      name: 'iaero-points-api',
              chainId: j.chainId ?? null,
              head: j.head ?? null,
              checkpoint: j.checkpoint ?? null,
              lag: j.lag ?? null,
              targets: Array.isArray(j.targets) ? j.targets : [],
 	    });
	   }

      }
  
      // Fallback: DB-only (still lets the “Checkpoint” render)
      const checkpoint = await checkpointFromDb();
      return rep.send({
        ok: true,
        name: 'iaero-points-api',
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
        chainId: null,
        head: null,
        checkpoint,
        lag: null,
        targets: [],
        note: `health error: ${String(e?.message || e)}; checkpoint from DB`,
      });
    }
  });
  

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

    // Link a wallet to a Zealy userId (you can call this from a one-time Zealy API task or an admin UI)
    app.post('/admin/zealy/link', async (req: FastifyRequest, rep: FastifyReply) => {
      requireAdmin(req);
      const body = req.body as { zealyUserId?: string; wallet?: string };
      const zealyUserId = String(body?.zealyUserId || '');
      const wallet = String(body?.wallet || '').toLowerCase();
  
      if (!/^0x[0-9a-f]{40}$/.test(wallet) || !zealyUserId) {
        return rep.code(400).send({ ok: false, error: 'bad_params' });
      }
  
      const hex = wallet.slice(2);
      await pool.query(
        `INSERT INTO zealy_user_links(zealy_user_id, address)
         VALUES ($1, decode($2,'hex'))
         ON CONFLICT (zealy_user_id)
         DO UPDATE SET address = EXCLUDED.address, linked_at = now()`,
        [zealyUserId, hex]
      );
      return { ok: true };
    });
  
    // Push XP to Zealy for top N leaderboard entries (idempotent: only deltas)
    app.post('/admin/zealy/sync', async (req: FastifyRequest, rep: FastifyReply) => {
      requireAdmin(req);
  
      const maxN = Math.min(Number(process.env.ZEALY_SYNC_MAX || 1000), 5000);
      const factor = Number(process.env.ZEALY_XP_PER_POINT || 1);
      const reason = String(process.env.ZEALY_SYNC_REASON || 'iAero staking points sync');
  
      const { rows } = await pool.query(
        `
        SELECT
          encode(l.address, 'hex') AS address_hex,
          l.points::numeric        AS points,
          zul.zealy_user_id        AS zealy_user_id,
          COALESCE(zxs.last_points_synced, 0)::numeric AS last_points_synced
        FROM staking_points_leaderboard l
        JOIN zealy_user_links zul ON zul.address = l.address
        LEFT JOIN zealy_xp_sync zxs ON zxs.address = l.address
        ORDER BY l.points DESC
        LIMIT $1
        `,
        [maxN]
      );
  
      let pushed = 0, skipped = 0, failed = 0;
  
      for (const r of rows) {
        const totalPoints = Number(r.points);
        const lastSynced  = Number(r.last_points_synced);
        const delta       = totalPoints - lastSynced;
  
        // only push positive integer XP amounts
        const amount = Math.floor(delta * factor);
        if (!r.zealy_user_id || amount <= 0) { skipped++; continue; }
  
        try {
          await pushXP(r.zealy_user_id, amount, reason);
          pushed++;
  
          await pool.query(
            `INSERT INTO zealy_xp_sync(address, last_points_synced)
             VALUES (decode($1,'hex'), $2)
             ON CONFLICT (address) DO UPDATE
               SET last_points_synced = EXCLUDED.last_points_synced,
                   updated_at = now()`,
            [r.address_hex, totalPoints.toString()]
          );
        } catch (e) {
          failed++;
          req.log.error({ user: r.zealy_user_id, err: String(e) }, 'zealy push failed');
        }
      }
  
      return { ok: true, pushed, skipped, failed, processed: rows.length };
    });

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
