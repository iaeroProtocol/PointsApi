# iAERO Staking Points (Railway-ready)

Tracks **time-weighted staking points** for iAERO from the on-chain `EpochStakingDistributor` and exposes a **public REST API** (Zealy-friendly) plus simple endpoints you can wire into your website.

- **Points rule**: `1 point per day per iAERO staked`
- **Chain**: Base (8453)
- **Distributor**: `0x781A80fA817b5a146C440F03EF8643f4aca6588A`
- **Deploy target**: Railway (Postgres + Indexer worker + API service)

---

## How it works

**Indexer (apps/points-indexer)** subscribes to the distributor contract events:
- `Staked(address user, uint256 amount)`
- `StakedFor(address funder, address user, uint256 amount)`
- `Unstaked(address user, uint256 amount)`
- `Exited(address user, uint256 amount)`
- `Claimed(address user, uint256 amount)` or `RewardPaid(address user, uint256 reward)` (whichever your contract emits)

It accumulates an exact integral of **wei·seconds** for each address:
points_wei_days = Σ (balance_wei × Δt_seconds)
points = points_wei_days / (1e18 × 86_400)

markdown
Copy code
This gives precise time-weighted points and allows rule changes later without data loss.

**API (apps/points-api)** serves:
- `/points/:address` → current points, balance snapshot, last timestamp
- `/leaderboard` → top addresses by points (refreshed periodically)
- `/claimed/:address` → claim summary + recent claim events
- `/claimed` → paginated list of addresses that have ever claimed
- `/verify-zealy/:address?min=1000` → **boolean** for Zealy quest thresholds
- `/verify-zealy-claimed/:address` → **boolean** for “has claimed” quest
- `/health` → health check

---

## Repo layout

/apps
/points-indexer
Dockerfile
package.json
indexer.ts
abi.ts
/points-api
Dockerfile
package.json
server.ts
routes.ts
/packages
/db
migrations/0001_init.sql
migrations/0002_claims.sql
.env.sample
railway.json
README.md

yaml
Copy code

---

## Environment variables

Duplicate `.env.sample` → `.env` for local dev. On Railway, set the same vars in each service.

| Key              | Where            | Example / Notes                                  |
|------------------|------------------|--------------------------------------------------|
| `DATABASE_URL`   | Indexer + API    | From Railway Postgres plugin                     |
| `RPC_URL_BASE`   | Indexer          | Alchemy/Infura Base mainnet RPC                  |
| `CHAIN_ID`       | Indexer          | `8453`                                           |
| `EPOCH_DIST`     | Indexer          | `0x781A80fA817b5a146C440F03EF8643f4aca6588A`     |
| `CONFIRMATIONS`  | Indexer          | `5` (reorg safety)                               |
| `START_BLOCK`    | Indexer          | Optional: backfill start (block number)          |
| `PORT`           | API              | `8080`                                           |
| `CORS_ORIGIN`    | API              | `*` (tighten to your domains in prod)            |
| `RATE_LIMIT_PER_MIN` | API         | `600`                                            |

> **Backfill**: If you don’t want retro points, set `START_BLOCK` to current tip before first deploy. To backfill historically, set it to the distributor’s deployment block.

---

## Quick start (local)

> Prereqs: Node 20+, Docker (for Postgres), pnpm or npm

1) Start Postgres:
```bash
docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=iaero \
  -p 5432:5432 --name iaero-pg -d postgres:15
Copy env and fill values:

bash
Copy code
cp .env.sample .env
# edit RPC_URL_BASE, EPOCH_DIST, etc.
Install & run:

bash
Copy code
# API
cd apps/points-api
npm i
npm start

# Indexer (separate shell)
cd apps/points-indexer
npm i
npm start
Check:

bash
Copy code
GET http://localhost:8080/health         -> {"ok":true}
GET http://localhost:8080/points/0x...    -> { ... }
Deploy on Railway
Create a new Railway project, add Postgres plugin.

Deploy from GitHub (this repo). Railway will detect both services (subfolders).

Set env vars:

For both API and Indexer: DATABASE_URL (from plugin)

Indexer: RPC_URL_BASE, CHAIN_ID=8453, EPOCH_DIST=0x781..., CONFIRMATIONS=5, START_BLOCK=<<tip or historical>>

API: PORT=8080, CORS_ORIGIN=* (or your domain), RATE_LIMIT_PER_MIN=600

Open API service URL → /health

railway.json is included for a one-shot setup of services.

API reference (public)
All responses are JSON. Timestamps are UNIX seconds.

Health
bash
Copy code
GET /health
→ { "ok": true }
Points for a wallet
css
Copy code
GET /points/:address
→ {
  "address": "0xabc...",
  "points": "1234.5678901",
  "lastBalance": "100000000000000000000",     // wei
  "lastTimestamp": 1728771000
}
Leaderboard
bash
Copy code
GET /leaderboard?limit=100
→ [ { "address": "0x...", "points": "..." }, ... ]
Claims (summary + recent)
bash
Copy code
GET /claimed/:address
→ { "claimed": false }
or
→ {
  "claimed": true,
  "summary": {
    "firstTimestamp": 1728000000,
    "lastTimestamp": 1729000000,
    "claimCount": 12,
    "totalAmountWei": "123450000000000000000"
  },
  "recent": [
    {
      "txHash": "0x...",
      "logIndex": 12,
      "amountWei": "1000000000000000000",
      "blockNumber": 12345678,
      "timestamp": 1728999999
    }
  ]
}
All claimers (paginated)
pgsql
Copy code
GET /claimed?limit=100&offset=0
→ [
  {
    "address": "0x...",
    "firstTimestamp": 1728...,
    "lastTimestamp": 1729...,
    "claimCount": 3,
    "totalAmountWei": "..."
  }
]
Zealy verifiers
ruby
Copy code
GET /verify-zealy/:address?min=1000
→ { "ok": true, "points": "1234.56" }

GET /verify-zealy-claimed/:address
→ { "ok": true }
Data model
staking_points_wallet — current state & cumulative accumulator (wei·seconds)

staking_points_daily — optional day rollups (for charts)

staking_points_leaderboard — cached ranking (refreshed periodically)

staking_claims — append-only raw claim events

staking_claimers — summary per address (first/last/total)

Migrations are in packages/db/migrations/*. The indexer runs them on boot.

Ops & troubleshooting
Reorgs: Indexer waits CONFIRMATIONS blocks before mutating state.

Resume: A checkpoint (indexing_checkpoint) stores the last processed block.

Performance: Batch backfill in 10k block windows; adjust if your RPC rate-limits.

CORS: Lock CORS_ORIGIN to your production domains after testing.

Security: If you need authenticated verification for partners, add an HMAC header check on API routes.

License
Proprietary – iAERO Protocol internal tooling (update as desired).
