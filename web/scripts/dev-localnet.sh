#!/usr/bin/env bash
# Runs the app against the local sandbox written up by scripts/localnet-setup.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
source .env.localnet
set +a
exec node_modules/.bin/next dev --port 3001
