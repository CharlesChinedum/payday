// End-to-end smoke test of a running Payday web app.
// Usage: pnpm smoke [base-url]          (default http://localhost:3000, testnet)
//        node --env-file=.env.localnet scripts/smoke.mjs http://localhost:3001
//
// Plays both roles with fresh keys, paying no gas: gets test USDC, sets up the employer,
// funds a backdated salary stream, and the worker withdraws and sends USDC on. Then it
// replays the attacks from AUDIT.md and checks each is refused. Every step goes through
// the app's own API, so a pass means the deployment really works.

import { Account, JsonRpcProvider, KeyPair, Signature, actions, buildDelegateAction, encodeSignedDelegate } from "near-api-js";

const NETWORK = process.env.NEXT_PUBLIC_NETWORK ?? "testnet";
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://test.rpc.fastnear.com";
const PAYDAY = process.env.NEXT_PUBLIC_PAYDAY ?? "app.payday-dev.testnet";
const USDC = process.env.NEXT_PUBLIC_USDC ?? "usdc.payday-dev.testnet";

const BASE_URL = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const TGAS = 1_000_000_000_000n;
const ONE_USDC = 1_000_000n;
const SALARY = 60n * ONE_USDC;
const SEND = 5n * ONE_USDC;
const ACCOUNT_WAIT_MS = 30_000;

const provider = new JsonRpcProvider({ url: RPC_URL });
const view = (contractId, method, args) => provider.callFunction({ contractId, method, args });
const implicitId = (key) => Buffer.from(key.getPublicKey().ed25519Key.data).toString("hex");

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function ok(path, body) {
  const { status, data } = await post(path, body);
  if (status !== 200) throw new Error(`${path} -> ${status}: ${data.error}`);
  return data;
}

async function onboard(role, key) {
  const { created } = await ok("/api/onboard", { publicKey: key.getPublicKey().toString() });
  const accountId = implicitId(key);
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
  console.log(`✓ ${role} account set up (${created ? "created" : "existing"}): ${accountId}`);
  return new Account(accountId, provider, key.toString());
}

async function signedDelegate(account, receiverId, method, args, gasTgas, deposit = 0n) {
  const { signedDelegate: sd } = await account.createSignedMetaTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, BigInt(gasTgas) * TGAS, deposit)],
    blockHeightTtl: 120,
  });
  return Buffer.from(encodeSignedDelegate(sd)).toString("base64");
}

async function relay(account, receiverId, method, args, gasTgas, deposit = 0n) {
  return ok("/api/relay", { signedDelegate: await signedDelegate(account, receiverId, method, args, gasTgas, deposit) });
}

function expectEvent(outcome, event, step) {
  const found = outcome.events?.find((e) => e.standard === "payday" && e.event === event);
  if (!found) throw new Error(`${step}: no ${event} event. Failures: ${outcome.failures?.join("; ") || "none"}`);
  console.log(`✓ ${step}  tx ${outcome.txHash}`);
  return found.data[0];
}

async function expectRefused(step, promise, status) {
  const res = await promise;
  if (res.status !== status) throw new Error(`${step}: expected HTTP ${status}, got ${res.status} ${JSON.stringify(res.data)}`);
  console.log(`✓ refused: ${step} (${status} ${res.data.error ?? ""})`);
}

// ---------- the happy path ----------

const employerKey = KeyPair.fromRandom("ed25519");
const workerKey = KeyPair.fromRandom("ed25519");

await expectRefused(
  "setting up an account with nothing on-chain (H-02)",
  post("/api/onboard", { publicKey: employerKey.getPublicKey().toString() }),
  403,
);

if (NETWORK !== "mainnet") {
  const { txHash } = await ok("/api/faucet", { accountId: implicitId(employerKey) });
  console.log(`✓ employer got test USDC  tx ${txHash}`);
}
const employer = await onboard("employer", employerKey);
const { stream_fee: streamFee } = await view(PAYDAY, "config", {});

const now = Math.floor(Date.now() / 1000);
const stream = { worker: implicitId(workerKey), amount: SALARY.toString(), start: now - 3600, stop: now + 3600 };
const total = SALARY + BigInt(streamFee);
const funded = await relay(employer, USDC, "ft_transfer_call", { receiver_id: PAYDAY, amount: total.toString(), msg: JSON.stringify({ streams: [stream] }) }, 150, 1n);
const { id: streamId } = expectEvent(funded, "stream_created", "employer funded a 60 USDC stream (plus the stream fee)");

const worker = await onboard("worker", workerKey);
const withdrawDelegate = await signedDelegate(worker, PAYDAY, "withdraw", { stream_id: streamId }, 100);
const withdrawn = await ok("/api/relay", { signedDelegate: withdrawDelegate });
const paid = expectEvent(withdrawn, "paid", "worker withdrew, paying the one-time setup fee");
const balance = BigInt(await view(USDC, "ft_balance_of", { account_id: worker.accountId }));
if (balance !== BigInt(paid.amount) || balance < SALARY / 2n - ONE_USDC) {
  throw new Error(`worker balance ${balance} does not match the ${paid.amount} paid (about half of ${SALARY})`);
}
console.log(`✓ worker holds ${Number(balance) / 1e6} USDC, having paid no gas`);

const receiver = KeyPair.fromRandom("ed25519");
const sent = await relay(worker, USDC, "ft_transfer_call", { receiver_id: PAYDAY, amount: SEND.toString(), msg: JSON.stringify({ send_to: implicitId(receiver) }) }, 150, 1n);
const sendPaid = expectEvent(sent, "paid", "worker sent 5 USDC on to a fresh account (exit path)");
const received = BigInt(await view(USDC, "ft_balance_of", { account_id: implicitId(receiver) }));
if (received !== BigInt(sendPaid.amount)) throw new Error(`receiver got ${received}, event says ${sendPaid.amount}`);

// ---------- the audit's attacks ----------

const stranger = KeyPair.fromRandom("ed25519");
const forged = actions.signedDelegate({
  delegateAction: buildDelegateAction({
    senderId: implicitId(stranger),
    receiverId: PAYDAY,
    actions: [actions.functionCall("withdraw", { stream_id: 1 }, 100n * TGAS, 0n)],
    nonce: 1n,
    maxBlockHeight: 10n ** 12n,
    publicKey: stranger.getPublicKey(),
  }),
  signature: new Signature({ keyType: 0, data: new Uint8Array(64) }),
}).signedDelegate;
await expectRefused(
  "a delegate with a forged signature (H-01)",
  post("/api/relay", { signedDelegate: Buffer.from(encodeSignedDelegate(forged)).toString("base64") }),
  403,
);

await expectRefused("replaying a delegate that was already used (H-01)", post("/api/relay", { signedDelegate: withdrawDelegate }), 409);

const claim = await signedDelegate(worker, PAYDAY, "claim_owed", {}, 100);
await expectRefused("a call with nothing to claim (pre-flight)", post("/api/relay", { signedDelegate: claim }), 409);

await expectRefused(
  "a cross-site POST (M-09)",
  post("/api/onboard", { publicKey: stranger.getPublicKey().toString() }, { Origin: "https://evil.example" }),
  403,
);
await expectRefused(
  "a text/plain POST (M-09)",
  post("/api/onboard", JSON.stringify({ publicKey: "x" }), { "Content-Type": "text/plain" }),
  415,
);
await expectRefused("a 40,000-character public key (M-06)", post("/api/onboard", { publicKey: `ed25519:${"1".repeat(40_000)}` }), 413);
await expectRefused("a malformed public key (M-06)", post("/api/onboard", { publicKey: `ed25519:${"1".repeat(60)}` }), 400);

console.log(`\nPASS  ${BASE_URL} (${NETWORK})`);
