#!/usr/bin/env bash
# Hands the Payday contract to a Sputnik DAO and removes the contract account's keys
# (AUDIT M-03). After this, the only way to change the code is a DAO vote: the DAO stores
# the new wasm as a blob and an UpgradeRemote proposal calls Payday's `upgrade` with it.
#
# Prints the NEAR CLI commands in order rather than running them: each step changes
# who controls the contract, so each is signed and checked by a person.
#
#   scripts/handover.sh <payday-account> <dao-account> <current-owner> <network>
#   scripts/handover.sh app.paydayhq.near paydayhq.sputnik-dao.near paydayhq.near mainnet
set -euo pipefail

if [ $# -ne 4 ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
PAYDAY=$1 DAO=$2 OWNER=$3 NET=$4
DIR="$(cd "$(dirname "$0")/.." && pwd)"
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
BOND=$(near contract call-function as-read-only "$DAO" get_policy json-args '{}' network-config "$NET" now 2>/dev/null |
  python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t[t.index("{"):])["proposal_bond"])' 2>/dev/null || echo "<proposal_bond from get_policy>")

cat <<EOF
# 1. The current owner proposes the DAO as owner.
near contract call-function as-transaction $PAYDAY propose_owner json-args '{"new_owner":"$DAO"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $OWNER network-config $NET

# 2. A council member asks the DAO to accept (bond: $BOND yoctoNEAR), then the council votes on
#    it, e.g. from Payday's /dao page or with act_proposal.
near contract call-function as-transaction $DAO add_proposal json-args '{"proposal":{"description":"Accept ownership of the Payday contract $PAYDAY","kind":{"FunctionCall":{"receiver_id":"$PAYDAY","actions":[{"method_name":"accept_owner","args":"$(b64 '{}')","deposit":"0","gas":"30000000000000"}]}}}}' prepaid-gas '50 Tgas' attached-deposit '$BOND yoctoNEAR' sign-as <council-member> network-config $NET

# 3. Check before going further: owner must be $DAO.
near contract call-function as-read-only $PAYDAY config json-args '{}' network-config $NET now

# 4. List the contract account's keys, then delete every one of them. Only after step 3
#    shows the DAO as owner: with no keys, the DAO is the only way in.
near account list-keys $PAYDAY network-config $NET now
near account delete-keys $PAYDAY public-keys <each-public-key> network-config $NET

# 5. Check: no keys left, and the deployed code is the reproducible build of the tagged commit.
near account list-keys $PAYDAY network-config $NET now
near account view-account-summary $PAYDAY network-config $NET now   # code_hash
scripts/code_hash.py contract/target/near/payday.wasm               # from "cargo near build reproducible-wasm"

# Upgrades from now on: store the reproducible wasm as a blob on the DAO (the deposit pays
# its storage, about 1 NEAR per 100 KB), then propose an UpgradeRemote with the hash it returns.
near contract call-function as-transaction $DAO store_blob file-args $DIR/contract/target/near/payday.wasm prepaid-gas '100 Tgas' attached-deposit '<wasm KB / 100 + 0.1> NEAR' sign-as <council-member> network-config $NET
near contract call-function as-transaction $DAO add_proposal json-args '{"proposal":{"description":"Upgrade Payday to <commit>","kind":{"UpgradeRemote":{"receiver_id":"$PAYDAY","method_name":"upgrade","hash":"<hash from store_blob>"}}}}' prepaid-gas '50 Tgas' attached-deposit '$BOND yoctoNEAR' sign-as <council-member> network-config $NET
EOF
