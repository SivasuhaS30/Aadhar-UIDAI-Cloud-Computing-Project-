#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Aadhaar 1:1 Auth Microservice — AWS EC2 (Ubuntu 22.04/24.04) Deploy Script
# Modes:
#   --mode single      (default) Single-EC2 simulated multi-region + NGINX stack
#   --mode az-primary  Zone A node (Primary Redis + Auth) behind AWS ALB
#   --mode az-replica  Zone B node (Replica Redis + Auth) behind AWS ALB
# ==============================================================================

MODE="single"
REGION=""
PRIMARY_IP=""
HMAC_ARG=""
AES_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --primary-ip)
      PRIMARY_IP="$2"
      shift 2
      ;;
    --hmac-secret)
      HMAC_ARG="$2"
      shift 2
      ;;
    --aes-key)
      AES_ARG="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [--mode single|az-primary|az-replica] [--region ap-south-1a] [--primary-ip <IP>] [--hmac-secret <HEX>] [--aes-key <HEX>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROTO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROTO_DIR"

echo "=== [1/6] Checking OS & swap headroom for t3.micro (mode=${MODE}) ==="
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 1800 ]; then
  echo "Creating 1 GiB swapfile to prevent OOM during Docker image builds on t3.micro..."
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
fi

echo "=== [2/6] Installing Docker Engine & Compose plugin (if missing) ==="
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg openssl
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
fi

DOCKER_CMD="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER_CMD="sudo docker"
fi

echo "=== [3/6] Preparing production .env configuration ==="
if [ "$MODE" = "single" ]; then
  if [ ! -f .env ]; then
    HMAC_RAND="${HMAC_ARG:-$(openssl rand -hex 32)}"
    AES_RAND="${AES_ARG:-$(openssl rand -hex 32)}"
    cat > .env <<EOF
NGINX_PORT=80
NGINX_HTTPS_PORT=443
HMAC_SECRET=${HMAC_RAND}
AES_KEY=${AES_RAND}
REQUIRE_HMAC=true
HMAC_WINDOW_SEC=60
OTP_TTL_SEC=300
REPLAY_TTL_SEC=60
REDIS_WAIT_REPLICAS=0
REDIS_WAIT_TIMEOUT_MS=50
DEMO_RETURN_OTP=true
LOG_MOCK_SMS=false
EOF
    chmod 600 .env
    echo "Generated fresh 256-bit HMAC_SECRET and AES_KEY in ${PROTO_DIR}/.env"
  else
    echo "Using existing ${PROTO_DIR}/.env"
  fi

  echo "=== [4/6] Building and starting single-host multi-region containers ==="
  $DOCKER_CMD compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

  echo "=== [5/6] Waiting for NGINX and regional health checks ==="
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1/nginx-health >/dev/null 2>&1 && curl -fsS http://127.0.0.1/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  $DOCKER_CMD compose -f docker-compose.yml -f docker-compose.prod.yml ps

elif [ "$MODE" = "az-primary" ]; then
  REGION="${REGION:-ap-south-1a}"
  if [ -f .env ] && [ -z "$HMAC_ARG" ]; then
    HMAC_VAL="$(grep -E '^HMAC_SECRET=' .env | cut -d '=' -f2- || true)"
    AES_VAL="$(grep -E '^AES_KEY=' .env | cut -d '=' -f2- || true)"
  fi
  HMAC_VAL="${HMAC_ARG:-${HMAC_VAL:-$(openssl rand -hex 32)}}"
  AES_VAL="${AES_ARG:-${AES_VAL:-$(openssl rand -hex 32)}}"

  cat > .env <<EOF
HTTP_PORT=80
REDIS_PORT=6379
REDIS_BIND_IP=0.0.0.0
REGION=${REGION}
REDIS_REPLICAOF_HOST=
REDIS_PRIMARY_URL=redis://redis:6379
REDIS_AUTO_PROMOTE=true
HMAC_SECRET=${HMAC_VAL}
AES_KEY=${AES_VAL}
REQUIRE_HMAC=true
HMAC_WINDOW_SEC=60
OTP_TTL_SEC=300
REPLAY_TTL_SEC=60
DEMO_RETURN_OTP=true
LOG_MOCK_SMS=false
EOF
  chmod 600 .env

  echo "=== [4/6] Building and starting Zone A Primary node (${REGION}) ==="
  $DOCKER_CMD compose -f docker-compose.az.yml up -d --build

  echo "=== [5/6] Waiting for local health check ==="
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  $DOCKER_CMD compose -f docker-compose.az.yml ps

  LOCAL_IP="$(curl -fsS --connect-timeout 2 http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || hostname -I | awk '{print $1}')"
  echo ""
  echo ">>> Run this on your Zone B EC2 instance (ap-south-1b) to join replication with shared secrets:"
  echo "./scripts/deploy-ec2.sh --mode az-replica --region ap-south-1b --primary-ip ${LOCAL_IP} --hmac-secret ${HMAC_VAL} --aes-key ${AES_VAL}"
  echo ""

elif [ "$MODE" = "az-replica" ]; then
  REGION="${REGION:-ap-south-1b}"
  if [ -z "$PRIMARY_IP" ] || [ -z "$HMAC_ARG" ] || [ -z "$AES_ARG" ]; then
    echo "Error: --mode az-replica requires --primary-ip, --hmac-secret, and --aes-key from Zone A."
    exit 1
  fi

  cat > .env <<EOF
HTTP_PORT=80
REDIS_PORT=6379
REDIS_BIND_IP=127.0.0.1
REGION=${REGION}
REDIS_REPLICAOF_HOST=${PRIMARY_IP}
REDIS_PRIMARY_URL=redis://${PRIMARY_IP}:6379
REDIS_AUTO_PROMOTE=true
HMAC_SECRET=${HMAC_ARG}
AES_KEY=${AES_ARG}
REQUIRE_HMAC=true
HMAC_WINDOW_SEC=60
OTP_TTL_SEC=300
REPLAY_TTL_SEC=60
DEMO_RETURN_OTP=true
LOG_MOCK_SMS=false
EOF
  chmod 600 .env

  echo "=== [4/6] Building and starting Zone B Replica node (${REGION} -> ${PRIMARY_IP}) ==="
  $DOCKER_CMD compose -f docker-compose.az.yml up -d --build

  echo "=== [5/6] Waiting for local health check ==="
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1/health >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  $DOCKER_CMD compose -f docker-compose.az.yml ps

else
  echo "Invalid --mode '${MODE}'. Expected single | az-primary | az-replica."
  exit 1
fi

echo "=== [6/6] Verification Summary ==="
PUBLIC_IP="$(curl -fsS --connect-timeout 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<EC2-PUBLIC-IP>')"
echo "Node Dashboard URL : http://${PUBLIC_IP}/"
echo "Node Health URL    : http://${PUBLIC_IP}/health"
curl -fsS http://127.0.0.1/health; echo ""
