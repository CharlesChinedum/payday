#!/usr/bin/env bash
# Payday on NEAR testnet.
#   scripts/testnet.sh deploy      create sub-accounts, deploy mock USDC + Payday 2.0
#   scripts/testnet.sh migrate-v1  one-off: replace 1.0.0 code with 2.0 and migrate its
#                                  state (uses the contract account's own key)
#   scripts/testnet.sh upgrade     upgrade through the contract: the owner (ROOT) sends
#                                  the new code to `upgrade`, which deploys and migrates.
#                                  Works after the contract account's keys are removed.
# To exercise a deployment end to end, run the web app's smoke test (web/: pnpm smoke).
# ROOT is your funded testnet account and becomes the contract owner; sub-account keys
# go to ~/.near-credentials.
set -euo pipefail

ROOT="${ROOT:-payday-dev.testnet}"
USDC="usdc.$ROOT"
APP="app.$ROOT"
NET="network-config testnet"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$DIR/contract/target/near/payday.wasm"
STORAGE="0.00125 NEAR"

root_sign() { echo "sign-with-keychain send"; }
sub_sign() { echo "sign-with-legacy-keychain send"; }

exists() { near account view-account-summary "$1" $NET now >/dev/null 2>&1; }

create() { # account, balance
  if exists "$1"; then echo "• $1 exists"; return; fi
  near account create-account fund-myself "$1" "$2" autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$ROOT" $NET $(root_sign)
}

build() {
  (cd "$DIR/contract" && cargo near build non-reproducible-wasm >/dev/null)
}

deploy() {
  (cd "$DIR/mock-usdc" && cargo near build non-reproducible-wasm >/dev/null)
  build
  create "$USDC" '2.5 NEAR'
  create "$APP" '3.5 NEAR'
  near contract deploy "$USDC" use-file "$DIR/mock-usdc/target/near/mock_usdc.wasm" \
    with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    $NET $(sub_sign)
  near contract deploy "$APP" use-file "$WASM" \
    with-init-call new json-args "{\"token\":\"$USDC\",\"owner\":\"$ROOT\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' $NET $(sub_sign)
  near contract call-function as-transaction "$USDC" storage_deposit \
    json-args "{\"account_id\":\"$APP\",\"registration_only\":true}" \
    prepaid-gas '30 Tgas' attached-deposit "$STORAGE" sign-as "$ROOT" $NET $(root_sign)
  echo "✓ Deployed: token $USDC, payday $APP, owner $ROOT"
}

migrate-v1() {
  build
  near contract deploy "$APP" use-file "$WASM" \
    with-init-call migrate json-args "{\"owner\":\"$ROOT\"}" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' $NET $(sub_sign)
  near contract call-function as-read-only "$APP" config json-args '{}' $NET now
}

upgrade() {
  build
  near contract call-function as-transaction "$APP" upgrade file-args "$WASM" \
    prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as "$ROOT" $NET $(root_sign)
  near contract call-function as-read-only "$APP" config json-args '{}' $NET now
}

"${1:?usage: $0 deploy|migrate-v1|upgrade}"
