import {
  Account,
  JsonRpcProvider,
  KeyPair,
  actions,
  encodeSignedDelegate,
  type KeyPairString,
} from "near-api-js";
import { config, TGAS } from "./config";
import type { StreamRecord } from "./csv";
import { eventsNamed, type TxOutcome } from "./outcome";

export type Role = "employer" | "worker";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

const storageKey = (role: Role) => `payday:${config.networkId}:key:${role}`;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function implicitId(keyPair: KeyPair): string {
  const key = keyPair.getPublicKey();
  if (!key.ed25519Key) throw new Error("Expected an ed25519 key");
  return bytesToHex(key.ed25519Key.data);
}

/** The browser's key for a role, created on first use. Returns null if storage is blocked. */
export function loadKeyPair(role: Role, create: boolean): KeyPair | null {
  try {
    const saved = localStorage.getItem(storageKey(role));
    if (saved) return KeyPair.fromString(saved as KeyPairString);
    if (!create) return null;
    const fresh = KeyPair.fromRandom("ed25519");
    localStorage.setItem(storageKey(role), fresh.toString());
    return fresh;
  } catch {
    return null;
  }
}

const onboarding = new Map<string, Promise<string>>();

/** Ensures the key's implicit account exists; concurrent callers share one request. */
export function onboard(keyPair: KeyPair): Promise<string> {
  const publicKey = keyPair.getPublicKey().toString();
  let pending = onboarding.get(publicKey);
  if (!pending) {
    pending = requestOnboarding(publicKey);
    pending.catch(() => onboarding.delete(publicKey));
    onboarding.set(publicKey, pending);
  }
  return pending;
}

async function requestOnboarding(publicKey: string): Promise<string> {
  const res = await fetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Could not create your account");
  return data.accountId as string;
}

export async function view<T>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const getStreams = (accountId: string) =>
  view<StreamRecord[]>(config.payday, "streams_of", { account_id: accountId });

export const getStream = (streamId: number) =>
  view<StreamRecord | null>(config.payday, "get_stream", { stream_id: streamId });

export async function getUsdcBalance(accountId: string): Promise<bigint> {
  return BigInt(await view<string>(config.usdc, "ft_balance_of", { account_id: accountId }));
}

export type RelayResult = (TxOutcome & { error?: undefined }) | { ok: false; error: string; txHash?: undefined };

/** True when the call ran and Payday or the token emitted `event`. */
export function emitted(res: RelayResult, standard: string, event: string): boolean {
  return res.error === undefined && eventsNamed(res, standard, event).length > 0;
}

/** The amount Payday paid out in a withdrawal, or null if the call did not withdraw. */
export function withdrawnAmount(res: RelayResult): bigint | null {
  if (res.error !== undefined) return null;
  const data = eventsNamed(res, "payday", "withdrawn")[0]?.data[0];
  if (typeof data !== "object" || data === null || !("amount" in data) || typeof data.amount !== "string") return null;
  return BigInt(data.amount);
}

/** The most useful explanation for a call that did not do what was asked. */
export function reason(res: RelayResult, fallback: string): string {
  return res.error ?? res.failures[0] ?? fallback;
}

/**
 * Signs a single function call as a delegate action and has the Payday relayer submit
 * it, so the signer pays no gas. Any attached deposit (at most 1 yoctoNEAR) comes from
 * the signer's own account.
 */
export async function relayCall(
  keyPair: KeyPair,
  receiverId: string,
  methodName: string,
  args: object,
  gasTgas: number,
  deposit = 0n,
): Promise<RelayResult> {
  const account = new Account(implicitId(keyPair), provider, keyPair.toString() as KeyPairString);
  const { signedDelegate } = await account.createSignedMetaTransaction({
    receiverId,
    actions: [actions.functionCall(methodName, args, BigInt(gasTgas) * TGAS, deposit)],
    blockHeightTtl: 120,
  });
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedDelegate: bytesToBase64(encodeSignedDelegate(signedDelegate)) }),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error ?? `Relayer returned ${res.status}` };
  return data as TxOutcome;
}

