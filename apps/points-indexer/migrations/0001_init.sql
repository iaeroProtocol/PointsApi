CREATE TABLE IF NOT EXISTS staking_points_wallet (
  address         BYTEA PRIMARY KEY,
  last_balance    NUMERIC(78, 0) NOT NULL,
  last_ts         BIGINT NOT NULL,
  points_wei_days NUMERIC(78, 0) NOT NULL,
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staking_points_daily (
  address   BYTEA NOT NULL,
  day       DATE NOT NULL,
  points    NUMERIC(60, 18) NOT NULL,
  PRIMARY KEY (address, day)
);

CREATE TABLE IF NOT EXISTS staking_points_leaderboard (
  address   BYTEA PRIMARY KEY,
  points    NUMERIC(60, 18) NOT NULL,
  rank      BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- simple progress checkpoint for safe restarts
CREATE TABLE IF NOT EXISTS indexing_checkpoint (
  id         SMALLINT PRIMARY KEY CHECK (id=1),
  last_block BIGINT NOT NULL
);
INSERT INTO indexing_checkpoint (id, last_block)
  VALUES (1, COALESCE(NULLIF('${START_BLOCK}','')::BIGINT, 0))
ON CONFLICT (id) DO NOTHING;
