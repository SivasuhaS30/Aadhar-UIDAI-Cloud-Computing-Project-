#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Automated Week 3 Benchmark Runner (Tests T1 - T6)
# Usage: BASE_URL=http://127.0.0.1 HMAC_SECRET=... ./k6/run_benchmarks.sh
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESULTS_DIR="${PROTO_DIR}/results/k6-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

BASE_URL="${BASE_URL:-http://127.0.0.1}"
if [ -f "${PROTO_DIR}/.env" ] && [ -z "${HMAC_SECRET:-}" ]; then
  HMAC_SECRET="$(grep -E '^HMAC_SECRET=' "${PROTO_DIR}/.env" | cut -d '=' -f2-)"
fi
HMAC_SECRET="${HMAC_SECRET:-aadhaar-prototype-aua-hmac-secret-2026}"

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 not found in PATH. Install Grafana k6 or run via grafana/k6 Docker image."
  exit 1
fi

echo "Saving k6 summaries to ${RESULTS_DIR}"

echo "=== T1: Baseline Latency (10 VUs, 60s) ==="
BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
  --summary-export="${RESULTS_DIR}/t1_baseline.json" \
  "${SCRIPT_DIR}/t1_baseline.js" | tee "${RESULTS_DIR}/t1_baseline.txt"

echo "=== T2 (Part A): 1-Replica Reference @ 200 RPS ==="
BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
  --summary-export="${RESULTS_DIR}/t2_1replica.json" \
  "${SCRIPT_DIR}/t2_scaling.js" | tee "${RESULTS_DIR}/t2_1replica.txt"

if command -v docker >/dev/null 2>&1 && [ -f "${PROTO_DIR}/docker-compose.yml" ]; then
  echo "=== T2 (Part B): Scaling region1_auth to 3 replicas & reloading NGINX ==="
  (cd "$PROTO_DIR" && docker compose up -d --scale region1_auth=3 --no-recreate && docker compose exec -T nginx nginx -s reload)
  sleep 3

  BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
    --summary-export="${RESULTS_DIR}/t2_3replicas.json" \
    "${SCRIPT_DIR}/t2_scaling.js" | tee "${RESULTS_DIR}/t2_3replicas.txt"

  echo "=== Restoring 1 replica per region before T3 ==="
  (cd "$PROTO_DIR" && docker compose up -d --scale region1_auth=1 --no-recreate && docker compose exec -T nginx nginx -s reload)
  sleep 2
fi

echo "=== T3: Peak Load Saturation (10 -> 500 VUs over 3m) ==="
BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
  --summary-export="${RESULTS_DIR}/t3_saturation.json" \
  "${SCRIPT_DIR}/t3_saturation.js" | tee "${RESULTS_DIR}/t3_saturation.txt"

if command -v docker >/dev/null 2>&1 && [ -f "${PROTO_DIR}/docker-compose.yml" ]; then
  echo "=== T4: Simulated Regional Failover (stopping region1_auth mid-test) ==="
  BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
    --summary-export="${RESULTS_DIR}/t4_failover.json" \
    "${SCRIPT_DIR}/t4_failover.js" | tee "${RESULTS_DIR}/t4_failover.txt" &
  K6_PID=$!
  sleep 15
  echo "[T4] Stopping region1_auth..."
  (cd "$PROTO_DIR" && docker compose stop region1_auth)
  wait "$K6_PID" || true
  echo "[T4] Restarting region1_auth..."
  (cd "$PROTO_DIR" && docker compose start region1_auth)
  sleep 3
fi

echo "=== T6: Replay Attack Filter (403 REPLAY_DETECTED) ==="
BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
  --summary-export="${RESULTS_DIR}/t6_replay.json" \
  "${SCRIPT_DIR}/t6_replay_filter.js" | tee "${RESULTS_DIR}/t6_replay.txt"

echo "=== T5: OTP TTL Auto-Expiry (301s wait) ==="
BASE_URL="$BASE_URL" HMAC_SECRET="$HMAC_SECRET" k6 run \
  --summary-export="${RESULTS_DIR}/t5_ttl_expiry.json" \
  "${SCRIPT_DIR}/t5_ttl_expiry.js" | tee "${RESULTS_DIR}/t5_ttl_expiry.txt"

echo "All k6 benchmarks completed. Results stored in: ${RESULTS_DIR}"

