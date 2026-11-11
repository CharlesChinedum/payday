#!/usr/bin/env bash
# Payday on NEAR testnet.
#   scripts/testnet.sh deploy   create sub-accounts, deploy mock USDC + Payday
#   scripts/testnet.sh demo     mint, fund two streams, withdraw, cancel, print balances
#                               (--skip-funding reuses streams 1 and 2 from an earlier run)
# ROOT is your funded testnet account; sub-account keys go to ~/.near-credentials.
set -euo pipefail

ROOT="${ROOT:-payday-dev.testnet}"
USDC="usdc.$ROOT"
APP="app.$ROOT"
ALICE="alice.$ROOT"
BOB="bob.$ROOT"
NET="network-config testnet"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORAGE="0.00125 NEAR"
U=1000000 # 1 USDC in base units

root_sign() { echo "sign-with-keychain send"; }
sub_sign() { echo "sign-with-legacy-keychain send"; }

exists() { near account view-account-summary "$1" $NET now >/dev/null 2>&1; }

create() { # account, balance
  if exists "$1"; then echo "• $1 exists"; return; fi
  near account create-account fund-myself "$1" "$2" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$ROOT" $NET $(root_sign)
}

call() { # signer, contract, method, json, deposit, sign-mode, [gas]
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${7:-300 Tgas}" attached-deposit "$5" sign-as "$1" $NET $6
}

view() { # contract, method, json
  near contract call-function as-read-only "$1" "$2" json-args "$3" $NET now 2>/dev/null
}

deploy() {
  (cd "$DIR/mock-usdc" && cargo near build non-reproducible-wasm >/dev/null)
  (cd "$DIR/contract" && cargo near build non-reproducible-wasm >/dev/null)
  create "$USDC" '2.5 NEAR'
  create "$APP" '3 NEAR'
  create "$ALICE" '0.05 NEAR'
  create "$BOB" '0.05 NEAR'
  near contract deploy "$USDC" use-file "$DIR/mock-usdc/target/near/mock_usdc.wasm" \
    with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    $NET $(sub_sign)
  near contract deploy "$APP" use-file "$DIR/contract/target/near/payday.wasm" \
    with-init-call new json-args "{\"token\":\"$USDC\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    $NET $(sub_sign)
  call "$ROOT" "$USDC" storage_deposit "{\"account_id\":\"$APP\",\"registration_only\":true}" "$STORAGE" "$(root_sign)"
  echo "✓ Deployed: token $USDC, payday $APP"
}

demo() {
  if [[ "${2:-}" != "--skip-funding" ]]; then fund; fi
  call "$ALICE" "$APP" withdraw '{"stream_id":1}' '0 NEAR' "$(sub_sign)" '40 Tgas'
  call "$ROOT" "$APP" cancel '{"stream_id":2}' '0 NEAR' "$(root_sign)" '40 Tgas'
  for a in "$ROOT" "$ALICE" "$BOB" "$APP"; do
    printf '%-28s %s\n' "$a" "$(view "$USDC" ft_balance_of "{\"account_id\":\"$a\"}")"
  done
}

fund() {
  call "$ROOT" "$USDC" mint "{\"account_id\":\"$ROOT\",\"amount\":\"$((3000 * U))\"}" '0 NEAR' "$(root_sign)"
  now=$(date +%s)
  msg="{\"streams\":[{\"worker\":\"$ALICE\",\"amount\":\"$((1000 * U))\",\"start\":$((now - 3600)),\"stop\":$((now + 30 * 86400))},{\"worker\":\"$BOB\",\"amount\":\"$((2000 * U))\",\"start\":$((now - 3600)),\"stop\":$((now + 30 * 86400))}]}"
  msg_json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$msg")
  call "$ROOT" "$USDC" ft_transfer_call \
    "{\"receiver_id\":\"$APP\",\"amount\":\"$((3000 * U))\",\"msg\":$msg_json}" '1 yoctoNEAR' "$(root_sign)"
  echo "--- streams for $ROOT"; view "$APP" streams_of "{\"account_id\":\"$ROOT\"}"
}

"${1:?usage: $0 deploy|demo [--skip-funding]}" "$@"
