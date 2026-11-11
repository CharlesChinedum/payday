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

export async function onboard(keyPair: KeyPair): Promise<string> {
  const res = await fetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: keyPair.getPublicKey().toString() }),
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

export async function getUsdcBalance(accountId: string): Promise<bigint> {
  return BigInt(await view<string>(config.usdc, "ft_balance_of", { account_id: accountId }));
}

export interface RelayResult {
  ok: boolean;
  txHash?: string;
  value?: unknown;
  error?: string;
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
  const data = (await res.json()) as RelayResult;
  if (!res.ok) return { ok: false, error: data.error ?? `Relayer returned ${res.status}` };
  return data;
}

