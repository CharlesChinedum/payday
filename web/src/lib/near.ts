import { Account, JsonRpcProvider, actions, encodeSignedDelegate, type KeyPair } from "near-api-js";
import { config, TGAS } from "./config";
import type { StreamRecord } from "./csv";
import { accountIdOf, type BrowserKey } from "./keys";
import { eventsNamed, type ChainEvent, type TxOutcome } from "./outcome";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

const STREAM_PAGE = 100;
const MAX_STREAM_PAGES = 10;
/** About two minutes of blocks: long enough to submit, short enough to be useless later. */
const DELEGATE_TTL_BLOCKS = 120;

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** The NEAR account a key controls: its 32 bytes in hex. Usable before the account exists. */
export const implicitId = (keyPair: KeyPair): string => accountIdOf(keyPair.getPublicKey());

async function postJson(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

const errorOf = (data: Record<string, unknown>, fallback: string) =>
  typeof data.error === "string" ? data.error : fallback;

const onboarding = new Map<string, Promise<void>>();

/** Reads the chain directly, so existing accounts never cost a server round trip. */
export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId, blockQuery: { finality: "optimistic" } });
    return true;
  } catch {
    // Missing or unreadable: the server decides, and it tells the two apart.
    return false;
  }
}

/**
 * Makes sure the key's account exists on-chain so it can sign. Payday creates it the
 * first time it has something to protect; concurrent callers share one request.
 */
function ensureAccount(key: BrowserKey): Promise<void> {
  const publicKey = key.publicKey.toString();
  let pending = onboarding.get(publicKey);
  if (!pending) {
    pending = accountExists(key.accountId).then(async (exists) => {
      if (exists) return;
      const { status, data } = await postJson("/api/onboard", { publicKey });
      if (status !== 200) throw new Error(errorOf(data, "Could not set up your account"));
    });
    pending.catch(() => onboarding.delete(publicKey));
    onboarding.set(publicKey, pending);
  }
  return pending;
}

/** Test networks: mints mock USDC to an account, which need not exist yet. */
export async function requestTestUsdc(accountId: string): Promise<{ txHash: string }> {
  const { status, data } = await postJson("/api/faucet", { accountId });
  if (status !== 200) throw new Error(errorOf(data, "Could not get test USDC"));
  return { txHash: String(data.txHash) };
}

export type RelayResult =
  | { status: "done"; outcome: TxOutcome }
  /** Sent, but not confirmed in time: re-read chain state before trying again. */
  | { status: "unknown" }
  | { status: "refused"; error: string };

/**
 * Signs a single function call as a delegate action and has the Payday relayer submit
 * it. The relayer pays the gas and any attached deposit (the policy allows 1 yoctoNEAR
 * at most), so the signer needs no NEAR.
 */
export async function relayCall(
  key: BrowserKey,
  receiverId: string,
  methodName: string,
  args: object,
  gasTgas: number,
  deposit = 0n,
): Promise<RelayResult> {
  try {
    await ensureAccount(key);
  } catch (e) {
    return { status: "refused", error: e instanceof Error ? e.message : String(e) };
  }
  const account = new Account(key.accountId, provider, key.signer);
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId,
    actions: [actions.functionCall(methodName, args, BigInt(gasTgas) * TGAS, deposit)],
    blockHeightTtl: DELEGATE_TTL_BLOCKS,
  });
  const { status, data } = await postJson("/api/relay", {
    signedDelegate: bytesToBase64(encodeSignedDelegate(signedDelegate)),
  });
  if (status === 202) return { status: "unknown" };
  if (status !== 200) return { status: "refused", error: errorOf(data, `Relayer returned ${status}`) };
  return { status: "done", outcome: data as unknown as TxOutcome };
}

// ---------- reading the chain ----------

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

/** Every live stream of an account, page by page. */
export async function getStreams(accountId: string): Promise<StreamRecord[]> {
  const count = await view<number>(config.payday, "stream_count_of", { account_id: accountId });
  const pages = Math.min(Math.ceil(count / STREAM_PAGE), MAX_STREAM_PAGES);
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      view<StreamRecord[]>(config.payday, "streams_of", { account_id: accountId, from_index: i * STREAM_PAGE, limit: STREAM_PAGE }),
    ),
  );
  return results.flat();
}

export const getStream = (streamId: number) => view<StreamRecord | null>(config.payday, "get_stream", { stream_id: streamId });

export const getUsdcBalance = async (accountId: string) =>
  BigInt(await view<string>(config.usdc, "ft_balance_of", { account_id: accountId }));

/** Whether an account can receive USDC without Payday registering it (and charging the fee). */
export async function isRegisteredForUsdc(accountId: string): Promise<boolean> {
  return (await view<unknown>(config.usdc, "storage_balance_of", { account_id: accountId })) !== null;
}

export const getOwed = async (accountId: string) =>
  BigInt(await view<string>(config.payday, "owed_of", { account_id: accountId }));

export interface Fees {
  stream: bigint;
  registration: bigint;
  /** Charged on every withdrawal, claim and send. */
  payout: bigint;
}

export async function getFees(): Promise<Fees> {
  const c = await view<{ stream_fee: string; registration_fee: string; payout_fee: string }>(config.payday, "config");
  return { stream: BigInt(c.stream_fee), registration: BigInt(c.registration_fee), payout: BigInt(c.payout_fee) };
}

// ---------- reading outcomes ----------

export interface Payout {
  amount: bigint;
  fee: bigint;
  receiver: string;
  source: string;
}

function payoutsOf(events: ChainEvent[]): Payout[] {
  return events.flatMap((e) => {
    const d = e.data[0] as { amount?: string; fee?: string; receiver?: string; source?: { kind?: string } } | undefined;
    if (!d?.amount || !d.receiver) return [];
    return [{ amount: BigInt(d.amount), fee: BigInt(d.fee ?? "0"), receiver: d.receiver, source: d.source?.kind ?? "" }];
  });
}

/** Payouts Payday completed in this transaction. */
export const paidOut = (outcome: TxOutcome) => payoutsOf(eventsNamed(outcome, "payday", "paid"));

/** Why a payout in this transaction did not go through, if one failed. */
export function payoutFailure(outcome: TxOutcome): string | null {
  const failed = eventsNamed(outcome, "payday", "payout_failed")[0]?.data[0] as
    | { reason?: string; credited_to?: string }
    | undefined;
  if (!failed) return null;
  const where = failed.credited_to === "stream" ? "it is back in your stream" : "you can claim it from your account";
  return `${failed.reason ?? "the transfer failed"}; ${where}`;
}

/** The most useful explanation for a call that did not do what was asked. */
export function explain(outcome: TxOutcome, fallback: string): string {
  return payoutFailure(outcome) ?? outcome.failures[0] ?? fallback;
}
