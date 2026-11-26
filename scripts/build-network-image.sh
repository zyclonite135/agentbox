#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
docker build -t "${AGENTBOX_NETWORK_IMAGE:-agentbox-network:latest}" "$ROOT/images/network"
