-- Map a Zealy user to a wallet (Base)
CREATE TABLE IF NOT EXISTS zealy_user_links (
  zealy_user_id TEXT PRIMARY KEY,
  address       BYTEA UNIQUE NOT NULL,     -- 0x… hex decoded
  linked_at     TIMESTAMP NOT NULL DEFAULT now()
);

-- Track how many "points" we've already converted to XP (idempotent sync)
CREATE TABLE IF NOT EXISTS zealy_xp_sync (
  address            BYTEA PRIMARY KEY,
  last_points_synced NUMERIC(60,18) NOT NULL DEFAULT 0,  -- same units as staking_points_leaderboard.points
  updated_at         TIMESTAMP NOT NULL DEFAULT now()
);
