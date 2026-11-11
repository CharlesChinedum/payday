#!/usr/bin/env bash
# Runs a local NEAR sandbox node for end-to-end testing (RPC on http://127.0.0.1:3030).
# Needs the near-sandbox binary: set NEAR_SANDBOX_BIN, or run the contract tests once
# (cargo test) and it is found under contract/target.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$DIR/.localnet"
BIN="${NEAR_SANDBOX_BIN:-$(find "$DIR/../contract/target" -type f -name near-sandbox -perm -u+x 2>/dev/null | head -1)}"
[[ -x "$BIN" ]] || { echo "near-sandbox not found; set NEAR_SANDBOX_BIN" >&2; exit 1; }
if [[ ! -f "$HOME_DIR/validator_key.json" ]]; then
  "$BIN" --home "$HOME_DIR" init --fast
fi
exec "$BIN" --home "$HOME_DIR" run --rpc-addr 127.0.0.1:3030 --network-addr 127.0.0.1:3031
