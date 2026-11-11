#!/usr/bin/env bash
# Builds both contracts to <crate>/target/near/*.wasm.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
for crate in mock-usdc contract; do
  (cd "$DIR/$crate" && cargo near build non-reproducible-wasm)
done
