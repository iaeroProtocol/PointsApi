/* eslint-disable no-console */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { Client as PgClient } from 'pg';
import * as ethersAll from 'ethers';

// ---------- ENV (typed & coerced) ----------
const {
  DATABASE_URL: DATABASE_URL_RAW = '',
  RPC_URL: RPC_URL_RAW = process.env.RPC_URL_BASE || '',
  TARGETS: TARGETS_RAW = process.env.EPOCH_DIST || '',
  START_BLOCK: START_BLOCK_RAW,
  CONFIRMATIONS: CONFIRMATIONS_RAW = '5',
  STEP: STEP_RAW = '2000',
  POLL_MS: POLL_MS_RAW = '6000',
  HEALTH_PORT: HEALTH_PORT_RAW = '8090',
} = process.env;

const FORCE_BACKFILL = String(process.env.FORCE_BACKFILL || '0') === '1';


// strings (for drivers/URLs)
const DATABASE_URL: string = String(DATABASE_URL_RAW);
const RPC_URL: string = String(RPC_URL_RAW);

// numbers (for math/comparisons/timers)
const START_BLOCK_NUM: number = Number(START_BLOCK_RAW ?? 0);
const CONFIRMATIONS_NUM: number = Number(CONFIRMATIONS_RAW);
const STEP_NUM: number = Number(STEP_RAW);
const POLL_MS_NUM: number = Number(POLL_MS_RAW);
const HEALTH_PORT_NUM: number = Number(process.env.PORT ?? HEALTH_PORT_RAW ?? 8090);
const HEARTBEAT_EVERY_SEC = Number(process.env.HEARTBEAT_EVERY_SEC || 300); // 5 min

console.log('[env] START_BLOCK_RAW=', START_BLOCK_RAW, 'parsed=', START_BLOCK_NUM);

// targets list (array of hex addresses as strings)
const TARGETS_ARR: string[] = String(TARGETS_RAW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!RPC_URL) throw new Error('RPC_URL (or RPC_URL_BASE) is required');
if (!TARGETS_ARR.length) console.warn('[warn] No TARGETS/EPOCH_DIST set; you may see logs=0');
// Derived tunables
const CONF_LAG = Math.max(0, CONFIRMATIONS_NUM);
const STEP_SIZE = Math.min(25_000, Math.max(1000, STEP_NUM));
const POLL_INTERVAL = Math.max(2000, POLL_MS_NUM);

// ---- Ethers v5/v6 compatibility ----
type AnyInterface = any;
function makeInterface(abi: any): AnyInterface {
  const anyE = ethersAll as any;

  const looksLikeHumanReadable =
    Array.isArray(abi) && abi.length > 0 && typeof abi[0] === 'string';

  const parsed =
    looksLikeHumanReadable && typeof anyE.parseAbi === 'function'
      ? anyE.parseAbi(abi) // v6: turn strings into Fragments
      : abi;

  if (anyE.Interface) return new anyE.Interface(parsed); // v6
  if (anyE.utils?.Interface) return new anyE.utils.Interface(parsed); // v5
  throw new Error('Unsupported ethers build: no Interface ctor');
}

function isWebSocket(url: string) {
  return url.startsWith('ws://') || url.startsWith('wss://');
}
function makeProvider(rpc: string) {
  const anyE = ethersAll as any;
  if (isWebSocket(rpc)) {
    const P = anyE.WebSocketProvider || anyE.providers?.WebSocketProvider;
    return new P(rpc);
  }
  const P = anyE.JsonRpcProvider || anyE.providers?.JsonRpcProvider;
  return new P(rpc);
}
function hexlifyAddress(addr: string) {
  return addr.toLowerCase();
}


// ---- ABI + topics (v5/v6 safe) ----
import { stakingAbi } from './abi';

// Widen the tuple length to a plain number to avoid TS2367
const abiLen: number = Array.isArray(stakingAbi) ? (stakingAbi as any[]).length : 0;

if (abiLen === 0) {
  console.error('[abi] stakingAbi is missing or empty. Check import path and export style.');
  process.exit(1);
}

function topicsForCompat(iface: AnyInterface, wantedNames: string[]) {
  const topics: string[] = [];
  const byName = new Map<string, any>();

  if (Array.isArray((iface as any).fragments)) {
    for (const f of (iface as any).fragments) {
      if (f && f.type === 'event' && f.name) byName.set(f.name, f);
    }

    for (const name of wantedNames) {
      const frag = byName.get(name);
      if (!frag) continue;

      try {
        topics.push((iface as any).getEventTopic(frag));
        continue;
      } catch {}

      try {
        const sig = `${frag.name}(${frag.inputs.map((i: any) => i.type).join(',')})`;
        const { keccak256, toUtf8Bytes } = (ethersAll as any);
        topics.push(keccak256(toUtf8Bytes(sig)));
        continue;
      } catch {}
    }
  }

  if (!topics.length && (iface as any).events) {
    const evs = Object.values((iface as any).events) as any[];
    for (const frag of evs) {
      if (frag && wantedNames.includes(frag.name)) {
        topics.push((iface as any).getEventTopic(frag));
      }
    }
  }

  if (!topics.length) {
    const found = Array.from(byName.keys());
    console.error('[abi] Could not resolve topics. Wanted:', wantedNames.join(', '), '| discovered:', found.join(', '));
  } else {
    console.log('[abi] topics resolved:', topics);
  }
  return topics;
}

console.log(
  '[abi] shape:',
  Array.isArray(stakingAbi) ? `array(len=${stakingAbi.length})` : typeof stakingAbi
);
if (Array.isArray(stakingAbi)) {
  console.log('[abi] first entry preview:', stakingAbi[0]);
}

const iface = makeInterface(stakingAbi as any);

const discoveredNames = (iface?.fragments || [])
  .filter((f: any) => f?.type === 'event')
  .map((f: any) => f?.name);

if (discoveredNames.length) {
  console.log('[abi] events found:', discoveredNames);
}

const EVENT_NAMES = ['Staked', 'StakedFor', 'Unstaked', 'Exited', 'RewardClaimed'];
const INTERESTING_TOPICS = topicsForCompat(iface, EVENT_NAMES);
if (!INTERESTING_TOPICS.length) {
  console.error('No valid topics resolved from stakingAbi. Check event names against your ABI.');
  process.exit(1);
}

// ---- DB ----
const pg = new PgClient({
  connectionString: DATABASE_URL,
  ssl: /amazonaws|railway|neon|supabase/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

async function runMigrations(defaultSeed?: bigint) {
  console.log('[boot] running migrations…');
  const dir = path.join(process.cwd(), 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort() : [];
  console.log(`[boot] migrations dir=${dir} files=${files.length ? files.join(', ') : '(none)'}`);

  const seedStr = (defaultSeed ?? 0n).toString();

  for (const f of files) {
    let sql = fs.readFileSync(path.join(dir, f), 'utf8');
    sql = sql.replace(/\$\{START_BLOCK\}/g, seedStr);
    if (!sql.trim()) continue;
    console.log(`[boot] applying ${f}…`);
    await pg.query(sql);
  }
  console.log('[boot] migrations complete');
}


async function ensureCheckpoint(defaultSeed: bigint) {
  const res = await pg.query('select last_block from indexing_checkpoint limit 1');
  if (res.rowCount === 0) {
    // Prefer explicit env START_BLOCK; else fall back to default (safe head)
    const first = START_BLOCK_NUM ? BigInt(START_BLOCK_NUM) : defaultSeed;
    await pg.query('insert into indexing_checkpoint(last_block) values ($1)', [first.toString()]);
    return first;
  }
  return BigInt(res.rows[0].last_block);
}

async function saveCheckpoint(bn: bigint) {
  await pg.query('update indexing_checkpoint set last_block=$1', [bn.toString()]);
}


async function heartbeatAccrual(nowTs: bigint) {
  // Accrue for wallets holding a balance whose last_ts < nowTs
  const { rows } = await pg.query(
    `SELECT encode(address,'hex') AS hex
       FROM staking_points_wallet
      WHERE last_balance > 0 AND last_ts < $1
      LIMIT 2000`,
    [nowTs.toString()],
  );

  for (const r of rows) {
    const addrHex = String(r.hex);
    // 0 delta => just accrue time and bump last_ts / points_wei_days
    await adjustBalanceWithAccrual(addrHex, 0n, nowTs);
  }
}




// ---- RPC helpers ----
const provider = makeProvider(RPC_URL);
let chainId: number | null = null;
let latestBlock: bigint = 0n;
let shuttingDown = false;

async function getChainId(): Promise<number> {
  const net = await (provider as any).getNetwork?.() ?? await (provider as any)._network;
  const id = Number(net.chainId ?? net?.chainId);
  if (!Number.isFinite(id)) throw new Error('Failed to resolve chainId');
  return id;
}

async function getBlockNumber(): Promise<bigint> {
  const n = await (provider as any).getBlockNumber();
  return BigInt(n);
}
async function getBlock(tsOrNum: number | bigint): Promise<any> {
  const v = typeof tsOrNum === 'bigint' ? Number(tsOrNum) : tsOrNum;
  return (provider as any).getBlock(v);
}

type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  removed?: boolean;
};
function isDesiredTopic(log: RawLog) {
  return log.topics?.length && INTERESTING_TOPICS.includes(log.topics[0]);
}

// ---- Backoff wrapper for getLogs ----
async function getLogsWithRetry(
  range: { fromBlock: bigint; toBlock: bigint },
  addresses: string[],
  topics: string[]
): Promise<RawLog[]> {
  const maxAttempts = 6;
  let delay = 750; // ms
  let attempt = 0;

  const filter: any = {
    fromBlock: Number(range.fromBlock),
    toBlock: Number(range.toBlock),
    address: addresses.length === 1 ? addresses[0] : addresses,
    topics: [topics],
  };

  while (attempt < maxAttempts) {
    try {
      const logs: RawLog[] = await (provider as any).getLogs(filter);
      return logs;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/rate|busy|timeout|429|exceed|limit|Gateway/i.test(msg)) {
        attempt++;
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(10_000, Math.floor(delay * 1.8));
        continue;
      }
      if (/block range|too many/i.test(msg) && (range.toBlock - range.fromBlock) > 1000n) {
        const mid = range.fromBlock + (range.toBlock - range.fromBlock) / 2n;
        const left = await getLogsWithRetry({ fromBlock: range.fromBlock, toBlock: mid }, addresses, topics);
        const right = await getLogsWithRetry({ fromBlock: mid + 1n, toBlock: range.toBlock }, addresses, topics);
        return left.concat(right);
      }
      throw e;
    }
  }
  throw new Error('getLogs failed after retries');
}

// ---- Targets ----
const TARGET_ADDRS = TARGETS_ARR.map(hexlifyAddress);
if (TARGET_ADDRS.length) {
  console.log('[boot] target contracts:', TARGET_ADDRS);
  console.log('[boot] topics:', INTERESTING_TOPICS);
}

// ---- Parser + handler hook ----
type ParsedLog = {
  name: string;
  args: any;
  log: RawLog;
};

function parseLog(log: RawLog): ParsedLog | null {
  try {
    const parsed = iface.parseLog({ data: log.data, topics: log.topics });
    return { name: parsed?.name, args: parsed?.args, log };
  } catch {
    return null;
  }
}

// ---------- Points math helpers (wei-days, daily splits, decimal format) ----------
const SECONDS_PER_DAY = 86_400n;
const WEI = 1_000_000_000_000_000_000n;

function toNo0x(hex: string) {
  return hex.startsWith('0x') ? hex.slice(2).toLowerCase() : hex.toLowerCase();
}
function toByteaParam(hexAddr: string) {
  return toNo0x(hexAddr);
}

function decimalFromWei(wei: bigint): string {
  const q = wei / WEI;
  const r = wei % WEI;
  const frac = r.toString().padStart(18, '0');
  return `${q}.${frac}`;
}

function* splitByUtcDays(s: bigint, e: bigint): Generator<[string, bigint]> {
  if (e <= s) return;
  const nextMidnight = (t: bigint) => {
    const d = new Date(Number(t) * 1000);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) / 1000;
    return BigInt(next);
  };
  let cur = s;
  while (cur < e) {
    const nm = nextMidnight(cur);
    const sliceEnd = e < nm ? e : nm;
    const d = new Date(Number(cur) * 1000);
    const dayStr = d.toISOString().slice(0, 10);
    yield [dayStr, sliceEnd - cur];
    cur = sliceEnd;
  }
}

// ---------- DB write helpers ----------
async function getWalletRow(addressHex: string) {
  const r = await pg.query(
    'select last_balance, last_ts, points_wei_days from staking_points_wallet where address=decode($1, \'hex\')',
    [addressHex],
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return {
    last_balance: BigInt(row.last_balance),
    last_ts: BigInt(row.last_ts),
    points_wei_days: BigInt(row.points_wei_days),
  };
}

async function upsertWallet(addressHex: string, last_balance: bigint, last_ts: bigint, points_wei_days: bigint) {
  await pg.query(
    `insert into staking_points_wallet(address,last_balance,last_ts,points_wei_days)
     values (decode($1,'hex'), $2, $3, $4)
     on conflict (address) do update set
       last_balance=EXCLUDED.last_balance,
       last_ts=EXCLUDED.last_ts,
       points_wei_days=EXCLUDED.points_wei_days,
       updated_at=now()`,
    [addressHex, last_balance.toString(), last_ts.toString(), points_wei_days.toString()],
  );
}

async function addDaily(addressHex: string, day: string, tokenDaysDelta: string) {
  await pg.query(
    `insert into staking_points_daily(address, day, points)
     values (decode($1,'hex'), $2::date, $3::numeric)
     on conflict (address, day) do update set
       points = staking_points_daily.points + EXCLUDED.points`,
    [addressHex, day, tokenDaysDelta],
  );
}

async function addLeaderboard(addressHex: string, tokenDaysDelta: string) {
  await pg.query(
    `insert into staking_points_leaderboard(address, points, rank)
     values (decode($1,'hex'), $2::numeric, 0)
     on conflict (address) do update set
       points = staking_points_leaderboard.points + EXCLUDED.points,
       updated_at = now()`,
    [addressHex, tokenDaysDelta],
  );
}

async function accruePoints(addressHex: string, balanceWei: bigint, prevTs: bigint, ts: bigint) {
  if (ts <= prevTs || balanceWei <= 0n) return 0n;

  let totalWeiDays = 0n;
  for (const [dayStr, seconds] of splitByUtcDays(prevTs, ts)) {
    const weiDays = (balanceWei * seconds) / SECONDS_PER_DAY;
    if (weiDays > 0n) {
      await addDaily(addressHex, dayStr, decimalFromWei(weiDays));
      totalWeiDays += weiDays;
    }
  }
  if (totalWeiDays > 0n) {
    await addLeaderboard(addressHex, decimalFromWei(totalWeiDays));
  }
  return totalWeiDays;
}

async function adjustBalanceWithAccrual(addressHex: string, amountWeiDelta: bigint, ts: bigint) {
  await pg.query('begin');
  try {
    const current = await getWalletRow(addressHex);
    let last_balance = current ? current.last_balance : 0n;
    let last_ts = current ? current.last_ts : ts;
    let points_wei_days = current ? current.points_wei_days : 0n;

    const inc = await accruePoints(addressHex, last_balance, last_ts, ts);
    points_wei_days += inc;

    last_balance = last_balance + amountWeiDelta;
    if (last_balance < 0n) last_balance = 0n;

    last_ts = ts;

    await upsertWallet(addressHex, last_balance, last_ts, points_wei_days);

    await pg.query('commit');
    return { last_balance, last_ts, points_wei_days };
  } catch (e) {
    await pg.query('rollback');
    throw e;
  }
}

// Claims tables
async function insertClaim(txHashHex: string, logIndex: number, addressHex: string, amountWei: bigint, blockNum: bigint, ts: bigint) {
  await pg.query(
    `insert into staking_claims(tx_hash, log_index, address, amount_wei, block_num, ts)
     values (decode($1,'hex'), $2, decode($3,'hex'), $4, $5, $6)
     on conflict (tx_hash, log_index) do nothing`,
    [txHashHex, logIndex, addressHex, amountWei.toString(), blockNum.toString(), ts.toString()],
  );

  await pg.query(
    `insert into staking_claimers(address, first_ts, last_ts, claim_count, total_wei)
     values (decode($1,'hex'), $2, $2, 1, $3)
     on conflict (address) do update set
       last_ts = GREATEST(staking_claimers.last_ts, EXCLUDED.last_ts),
       claim_count = staking_claimers.claim_count + 1,
       total_wei = staking_claimers.total_wei + EXCLUDED.total_wei`,
    [addressHex, ts.toString(), amountWei.toString()],
  );
}

// ---------- Event dispatcher ----------

async function handleParsedLog(p: ParsedLog, blockTime: number) {
  const name = p.name;
  const log = p.log;
  const bn = BigInt(log.blockNumber);
  const ts = BigInt(blockTime);

  const addrUser = p.args?.user ? toNo0x(String(p.args.user)) : '';
  const amountWei = p.args?.amount != null ? BigInt(p.args.amount.toString()) : 0n;

  switch (name) {
    case 'Staked':
    case 'StakedFor': {
      if (!addrUser) return;
      await adjustBalanceWithAccrual(addrUser, amountWei, ts);
      return;
    }
    case 'Unstaked':
    case 'Exited': {
      if (!addrUser) return;
      await adjustBalanceWithAccrual(addrUser, -amountWei, ts);
      return;
    }
    case 'RewardClaimed': {
      if (!addrUser) return;
      const txHashHex = toNo0x(log.transactionHash);
      await insertClaim(txHashHex, log.logIndex, addrUser, amountWei, bn, ts);
      return;
    }
    default:
      return;
  }
}

// ---- Backfill and live tail ----
async function backfill(from: bigint, to: bigint) {
  if (to < from) return from;
  const step = BigInt(STEP_SIZE);
  console.log(`[backfill] starting from=${from} to=${to} (step=${STEP_SIZE})`);
  let cur = from;
  let totalLogs = 0;

  while (cur <= to) {
    const end = cur + step - 1n > to ? to : cur + step - 1n;
    const logs = await getLogsWithRetry({ fromBlock: cur, toBlock: end }, TARGET_ADDRS, INTERESTING_TOPICS);
    const wanted = logs.filter(isDesiredTopic);
    totalLogs += wanted.length;

    const byBlock = new Map<number, RawLog[]>();
    for (const l of wanted) {
      const arr = byBlock.get(l.blockNumber) || [];
      arr.push(l);
      byBlock.set(l.blockNumber, arr);
    }

    for (const [bn, arr] of byBlock) {
      const blk = await getBlock(bn);
      const ts = Number(blk?.timestamp ?? 0);
      for (const l of arr) {
        const p = parseLog(l);
        if (p) await handleParsedLog(p, ts);
      }
    }

    cur = end + 1n;
    const processedBlocks = end - from + 1n;
    console.log(`[backfill] progressed → ${end} | logs=${totalLogs} | processedBlocks≈${processedBlocks}`);
    await saveCheckpoint(end);
    latestBlock = end;
    if (shuttingDown) break;
  }

  console.log(`[backfill] done. final checkpoint=${latestBlock}`);
  return latestBlock;
}

let lastHeartbeat = 0n;

async function liveTail(startFrom: bigint) {
  console.log('[live] subscribing to new blocks…');

  const onNewHead = async () => {
    try {
      const head = await getBlockNumber();
      const safeHead = head > BigInt(CONF_LAG) ? head - BigInt(CONF_LAG) : 0n;

      // Process new blocks if any
      if (safeHead > startFrom) {
        const logs = await getLogsWithRetry(
          { fromBlock: startFrom + 1n, toBlock: safeHead },
          TARGET_ADDRS,
          INTERESTING_TOPICS
        );
        const wanted = logs.filter(isDesiredTopic);

        const byBlock = new Map<number, RawLog[]>();
        for (const l of wanted) {
          const arr = byBlock.get(l.blockNumber) || [];
          arr.push(l);
          byBlock.set(l.blockNumber, arr);
        }

        let count = 0;
        for (const [bn, arr] of byBlock) {
          const blk = await getBlock(bn);
          const ts = Number(blk?.timestamp ?? 0);
          for (const l of arr) {
            const p = parseLog(l);
            if (p && !l.removed) {
              await handleParsedLog(p, ts);
              count++;
            }
          }
        }

        startFrom = safeHead;
        await saveCheckpoint(startFrom);
        latestBlock = startFrom;
        console.log(`[live] logs=${count} at block ${startFrom}`);
      }

      // Heartbeat accrual (runs even if no new blocks)
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (HEARTBEAT_EVERY_SEC > 0 && (now - lastHeartbeat) >= BigInt(HEARTBEAT_EVERY_SEC)) {
        await heartbeatAccrual(now);
        lastHeartbeat = now;
        console.log('[live] heartbeat accrual done at', now.toString());
      }
    } catch (e) {
      console.error('[live] error:', e);
    }
  };

  // subscribe or poll
  if ((provider as any).on && typeof (provider as any).on === 'function') {
    (provider as any).on('block', () => void onNewHead());
    const interval = setInterval(() => void onNewHead(), POLL_INTERVAL);
    return () => clearInterval(interval);
  } else {
    const interval = setInterval(() => void onNewHead(), POLL_INTERVAL);
    return () => clearInterval(interval);
  }
}


// ---- Health endpoint (useful for Railway) ----
let lastCheckpoint: bigint = 0n;
async function readCheckpoint(): Promise<bigint> {
  const r = await pg.query('select last_block from indexing_checkpoint limit 1');
  return r.rowCount ? BigInt(r.rows[0].last_block) : 0n;
}
const server = http.createServer(async (_req, res) => {
  if (_req.url === '/health') {
    try {
      const head = await getBlockNumber().catch(() => null);
      lastCheckpoint = await readCheckpoint().catch(() => lastCheckpoint);
      const body = JSON.stringify({
        ok: true,
        name: 'iaero-points-indexer',
        chainId,
        checkpoint: lastCheckpoint.toString(),
        head: head ? head.toString() : null,
        lag: head ? Number(head - lastCheckpoint) : null,
        targets: TARGET_ADDRS,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---- Main ----
(async () => {
  console.log('[boot] connecting to Postgres…');
  await pg.connect();
  console.log('[boot] connected to Postgres');

  chainId = await getChainId();
  console.log(`[boot] RPC ready chainId=${chainId}`);

  const head = await getBlockNumber();
  const safeHeadInit = head > BigInt(CONF_LAG) ? head - BigInt(CONF_LAG) : 0n;

  await runMigrations(safeHeadInit);
  let checkpoint = await ensureCheckpoint(safeHeadInit);
  
  // If forcing, reset the DB checkpoint to START_BLOCK on boot (idempotent)
  if (FORCE_BACKFILL && START_BLOCK_NUM > 0) {
    await saveCheckpoint(BigInt(START_BLOCK_NUM));
    checkpoint = BigInt(START_BLOCK_NUM);
    console.log('[init] forced checkpoint reset to START_BLOCK =', checkpoint.toString());
  }

  console.log(`[init] checkpoint=${checkpoint} head=${safeHeadInit}`);
  if (checkpoint < safeHeadInit) {
    checkpoint = await backfill(checkpoint, safeHeadInit);
  }

  lastCheckpoint = checkpoint;
  server.listen(HEALTH_PORT_NUM, '0.0.0.0', () => {
    console.log(`[health] listening on :${HEALTH_PORT_NUM}`);
  });

  const stopLive = await liveTail(checkpoint);

  // graceful shutdown
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] caught ${signal}, saving checkpoint=${latestBlock || lastCheckpoint}…`);
    try {
      await saveCheckpoint(latestBlock || lastCheckpoint);
    } catch (e) {
      console.error('[shutdown] failed to save checkpoint:', e);
    }
    try { stopLive && stopLive(); } catch {}
    try { server.close(); } catch {}
    try { await pg.end(); } catch {}
    try { (provider as any)?.destroy?.(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
})().catch(async (e) => {
  console.error(e);
  try { await pg.end(); } catch {}
  process.exit(1);
});
