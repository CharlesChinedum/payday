// Deploys mock USDC and Payday to a running local sandbox (scripts/localnet.sh), creates
// a funded relayer, and writes .env.localnet for `pnpm dev:localnet`. Build the contracts
// first (../scripts/build.sh). Safe to re-run: it starts from a fresh set of accounts.

import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");
const RPC = "http://127.0.0.1:3030";
const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

const provider = new JsonRpcProvider({ url: RPC });
const validator = JSON.parse(readFileSync(join(WEB, ".localnet/validator_key.json"), "utf8"));
const root = new Account(validator.account_id, provider, validator.secret_key ?? validator.private_key);
const run = Date.now().toString(36);

async function subAccount(name, near) {
  const key = KeyPair.fromRandom("ed25519");
  const accountId = `${name}-${run}.${root.accountId}`;
  await root.createAccount({ newAccountId: accountId, publicKey: key.getPublicKey(), nearToTransfer: near * NEAR });
  return { accountId, key, account: new Account(accountId, provider, key.toString()) };
}

async function deploy(target, wasmPath, init, args) {
  await target.account.deployContract(readFileSync(wasmPath));
  await target.account.callFunction({ contractId: target.accountId, methodName: init, args, gas: 30n * TGAS });
}

const usdc = await subAccount("usdc", 5n);
const payday = await subAccount("app", 10n);
const relayer = await subAccount("relayer", 50n);

await deploy(usdc, join(ROOT, "mock-usdc/target/near/mock_usdc.wasm"), "new", {});
await deploy(payday, join(ROOT, "contract/target/near/payday.wasm"), "new", { token: usdc.accountId, owner: root.accountId });
await root.callFunction({
  contractId: usdc.accountId,
  methodName: "storage_deposit",
  args: { account_id: payday.accountId, registration_only: true },
  deposit: 1_250_000_000_000_000_000_000n,
  gas: 30n * TGAS,
});

writeFileSync(
  join(WEB, ".env.localnet"),
  [
    "NEXT_PUBLIC_NETWORK=localnet",
    `NEXT_PUBLIC_RPC_URL=${RPC}`,
    `NEXT_PUBLIC_PAYDAY=${payday.accountId}`,
    `NEXT_PUBLIC_USDC=${usdc.accountId}`,
    `RELAYER_ACCOUNT_ID=${relayer.accountId}`,
    `RELAYER_PRIVATE_KEY=${relayer.key.toString()}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`localnet ready: payday ${payday.accountId}, usdc ${usdc.accountId}, relayer ${relayer.accountId}`);
