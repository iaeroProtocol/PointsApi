// apps/points-indexer/abi.ts
export const stakingAbi = [
  "event Staked(address indexed user,uint256 amount)",
  "event StakedFor(address indexed funder,address indexed user,uint256 amount)",
  "event Unstaked(address indexed user,uint256 amount)",
  "event Exited(address indexed user,uint256 amount)",
  "event RewardClaimed(address indexed user,address indexed token,uint256 indexed epochId,uint256 amount)"

] as const;


