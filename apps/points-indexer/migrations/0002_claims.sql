-- Raw claims log (append-only)
CREATE TABLE IF NOT EXISTS staking_claims (
  tx_hash     BYTEA NOT NULL,
  log_index   INTEGER NOT NULL,
  address     BYTEA NOT NULL,              -- claimer
  amount_wei  NUMERIC(78, 0) NOT NULL,
  block_num   BIGINT NOT NULL,
  ts          BIGINT NOT NULL,             -- unix seconds
  PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS staking_claims_addr_idx ON staking_claims (address);
CREATE INDEX IF NOT EXISTS staking_claims_block_idx ON staking_claims (block_num);

-- Fast lookup: has this address ever claimed?
CREATE TABLE IF NOT EXISTS staking_claimers (
  address     BYTEA PRIMARY KEY,
  first_ts    BIGINT NOT NULL,
  last_ts     BIGINT NOT NULL,
  claim_count BIGINT NOT NULL,
  total_wei   NUMERIC(78, 0) NOT NULL
);
