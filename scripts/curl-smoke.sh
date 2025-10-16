#!/usr/bin/env bash
set -euo pipefail

BASE=${BASE:-http://localhost:8080}
ADDR=${1:-0x0000000000000000000000000000000000000000}

echo "Health:"
curl -s ${BASE}/health | jq .

echo -e "\nPoints:"
curl -s ${BASE}/points/${ADDR} | jq .

echo -e "\nClaimed summary:"
curl -s ${BASE}/claimed/${ADDR} | jq .

echo -e "\nLeaderboard (top 5):"
curl -s "${BASE}/leaderboard?limit=5" | jq .

