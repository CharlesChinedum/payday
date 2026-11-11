import "server-only";
import { Account, JsonRpcProvider, PublicKey, parseNearAmount, type KeyPairString } from "near-api-js";
import { config } from "../config";
import { viewAccount } from "./chain";
import { HttpError } from "./http";

const provider = new JsonRpcProvider({ url: config.rpcUrl });

/** Below this the relayer stops paying for anything: a global stop no attacker resets. */
const BALANCE_FLOOR = BigInt(parseNearAmount(Number(process.env.RELAYER_MIN_BALANCE_NEAR || "0.5"))!);
const BALANCE_CACHE_MS = 20_000;

/** `ed25519:` plus 32 bytes in base58, checked before any decoding. */
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

let relayer: Account | undefined;

function relayerAccount(): Account {
  if (relayer) return relayer;
  const accountId = process.env.RELAYER_ACCOUNT_ID;
  const key = process.env.RELAYER_PRIVATE_KEY as KeyPairString | undefined;
  if (!accountId || !key) throw new Error("RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY must be set");
  relayer = new Account(accountId, provider, key);
  return relayer;
}

let balanceCheck: { at: number; ok: boolean } | undefined;

/**
 * Refuses to spend when the relayer is below its floor. Read from the chain, so it holds
 * across every server instance; cached briefly so it is not one RPC call per request.
 */
async function assertAboveFloor() {
  const now = Date.now();
  if (!balanceCheck || now - balanceCheck.at > BALANCE_CACHE_MS) {
    const state = await viewAccount(relayerAccount().accountId);
    balanceCheck = { at: now, ok: !!state && state.amount >= BALANCE_FLOOR };
  }
  if (!balanceCheck.ok) {
    throw new HttpError(503, "Payday's relayer is paused while it is topped up. Please try again later.");
  }
}

/** Every way the relayer spends goes through here, behind the balance floor. */
export async function spend<T>(work: (relayer: Account) => Promise<T>): Promise<T> {
  await assertAboveFloor();
  return work(relayerAccount());
}

/** The implicit account id controlled by an ed25519 public key: its 32 bytes in hex. */
export function implicitAccountId(publicKey: unknown): string {
  if (typeof publicKey !== "string" || !PUBLIC_KEY.test(publicKey)) {
    throw new HttpError(400, "publicKey must be an ed25519 public key");
  }
  const key = PublicKey.fromString(publicKey);
  if (!key.ed25519Key) throw new HttpError(400, "publicKey must be an ed25519 public key");
  return Buffer.from(key.ed25519Key.data).toString("hex");
}
