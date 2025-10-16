CREATE INDEX IF NOT EXISTS idx_leaderboard_points_desc ON staking_points_leaderboard (points DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_updated_at       ON staking_points_wallet (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_address_day       ON staking_points_daily (address, day);
CREATE INDEX IF NOT EXISTS idx_claims_address          ON staking_claims (address);
