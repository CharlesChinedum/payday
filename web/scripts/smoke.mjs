// End-to-end smoke test of a running Payday web app on NEAR testnet.
// Usage: pnpm smoke [base-url]      (default http://localhost:3000)
//
// Plays both roles with fresh keys, paying no gas: onboards an employer and a worker,
// mints test USDC, funds a backdated salary stream and withdraws from it. Every step
// goes through the app's own relayer, so a pass means the deployment really works.

import { Account, JsonRpcProvider, KeyPair, actions, encodeSignedDelegate } from "near-api-js";

// The testnet deployment, as in src/lib/config.ts.
const RPC_URL = "https://test.rpc.fastnear.com";
const PAYDAY = "app.payday-dev.testnet";
const USDC = "usdc.payday-dev.testnet";

const BASE_URL = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const TGAS = 1_000_000_000_000n;
const ONE_USDC = 1_000_000n;
const MINT = 100n * ONE_USDC;
const SALARY = 60n * ONE_USDC;
const ACCOUNT_WAIT_MS = 30_000;

const provider = new JsonRpcProvider({ url: RPC_URL });

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${data.error}`);
  return data;
}

async function onboard(role) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const { accountId, created } = await post("/api/onboard", { publicKey: keyPair.getPublicKey().toString() });
  const deadline = Date.now() + ACCOUNT_WAIT_MS;
  for (;;) {
    try {
      await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
      break;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`${role} account ${accountId} never appeared: ${e.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.log(`✓ ${role} onboarded (${created ? "created" : "existing"}): ${accountId}`);
  return { accountId, account: new Account(accountId, provider, keyPair.toString()) };
}

async function relay({ account }, receiverId, method, args, gasTgas, deposit = 0n) {
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, BigInt(gasTgas) * TGAS, deposit)],
    blockHeightTtl: 120,
  });
  const signed = Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
  return post("/api/relay", { signedDelegate: signed });
}

function expectEvent(outcome, standard, event, step) {
  const found = outcome.events.find((e) => e.standard === standard && e.event === event);
  if (!found) throw new Error(`${step}: no ${event} event. Failures: ${outcome.failures.join("; ") || "none"}`);
  console.log(`✓ ${step}  tx ${outcome.txHash}`);
  return found.data[0];
}

const view = (contractId, method, args) => provider.callFunction({ contractId, method, args });

const employer = await onboard("employer");
const worker = await onboard("worker");

const minted = await relay(employer, USDC, "mint", { account_id: employer.accountId, amount: MINT.toString() }, 10);
expectEvent(minted, "nep141", "ft_mint", "employer minted 100 test USDC");

const now = Math.floor(Date.now() / 1000);
const stream = { worker: worker.accountId, amount: SALARY.toString(), start: now - 3600, stop: now + 3600 };
const funded = await relay(
  employer,
  USDC,
  "ft_transfer_call",
  { receiver_id: PAYDAY, amount: SALARY.toString(), msg: JSON.stringify({ streams: [stream] }) },
  70,
  1n,
);
const { id: streamId } = expectEvent(funded, "payday", "stream_created", "employer funded a 60 USDC stream");

const withdrawn = await relay(worker, PAYDAY, "withdraw", { stream_id: streamId }, 40);
const { amount } = expectEvent(withdrawn, "payday", "withdrawn", "worker withdrew");

const balance = BigInt(await view(USDC, "ft_balance_of", { account_id: worker.accountId }));
if (balance !== BigInt(amount) || balance < SALARY / 2n) {
  throw new Error(`worker balance ${balance} does not match the ${amount} withdrawn (expected about half of ${SALARY})`);
}
console.log(`✓ worker holds ${Number(balance) / 1e6} USDC, about half the stream, having paid no gas`);
console.log(`\nPASS  ${BASE_URL}`);
