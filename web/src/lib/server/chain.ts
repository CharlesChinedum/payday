import "server-only";
import { config } from "../config";

const RPC_TIMEOUT_MS = 8_000;

/** The RPC answered, but with an error other than "does not exist". */
export class ChainError extends Error {}

interface RpcError {
  cause?: { name?: string };
  data?: string;
  message?: string;
}

async function rpc<T>(method: string, params: unknown): Promise<{ result?: T; error?: RpcError }> {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "payday", method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new ChainError(`RPC ${method} returned HTTP ${res.status}`);
  return (await res.json()) as { result?: T; error?: RpcError };
}

const isMissing = (error: RpcError | undefined, name: string) => error?.cause?.name === name;

/** null only when the RPC says the account does not exist; any other failure throws. */
export async function viewAccount(accountId: string): Promise<{ amount: bigint; storageUsage: number } | null> {
  const { result, error } = await rpc<{ amount: string; storage_usage: number }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
  if (isMissing(error, "UNKNOWN_ACCOUNT")) return null;
  if (error || !result) throw new ChainError(`view_account failed: ${JSON.stringify(error)}`);
  return { amount: BigInt(result.amount), storageUsage: result.storage_usage };
}

/** The access key's nonce, or null if the account has no such key (or does not exist). */
export async function accessKeyNonce(accountId: string, publicKey: string): Promise<bigint | null> {
  const { result, error } = await rpc<{ nonce: number | string }>("query", {
    request_type: "view_access_key",
    finality: "optimistic",
    account_id: accountId,
    public_key: publicKey,
  });
  if (isMissing(error, "UNKNOWN_ACCESS_KEY") || isMissing(error, "UNKNOWN_ACCOUNT")) return null;
  if (error || !result) throw new ChainError(`view_access_key failed: ${JSON.stringify(error)}`);
  return BigInt(result.nonce);
}

export async function blockHeight(): Promise<bigint> {
  const { result, error } = await rpc<{ header: { height: number } }>("block", { finality: "optimistic" });
  if (error || !result) throw new ChainError(`block failed: ${JSON.stringify(error)}`);
  return BigInt(result.header.height);
}

export async function viewFunction<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  const { result, error } = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (error || !result) throw new ChainError(`${contractId}.${method} failed: ${JSON.stringify(error)}`);
  return JSON.parse(Buffer.from(result.result).toString()) as T;
}

export interface StreamOnChain {
  id: number;
  employer: string;
  worker: string;
  deposit: string;
  withdrawn: string;
  withdrawable: string;
  start: number;
  stop: number;
}

export const getStream = (id: number) => viewFunction<StreamOnChain | null>(config.payday, "get_stream", { stream_id: id });

export const usdcBalanceOf = async (accountId: string) =>
  BigInt(await viewFunction<string>(config.usdc, "ft_balance_of", { account_id: accountId }));

export const owedOf = async (accountId: string) =>
  BigInt(await viewFunction<string>(config.payday, "owed_of", { account_id: accountId }));

export const streamCountOf = (accountId: string) =>
  viewFunction<number>(config.payday, "stream_count_of", { account_id: accountId });

export async function paydayConfig() {
  const c = await viewFunction<{ stream_fee: string; registration_fee: string; paused: boolean }>(
    config.payday,
    "config",
    {},
  );
  return { streamFee: BigInt(c.stream_fee), registrationFee: BigInt(c.registration_fee), paused: c.paused };
}

/**
 * Everything an account could spend through Payday right now: its USDC balance, what
 * its streams have vested, and what it is owed.
 */
export async function spendableOf(accountId: string): Promise<bigint> {
  const [balance, owed, count] = await Promise.all([usdcBalanceOf(accountId), owedOf(accountId), streamCountOf(accountId)]);
  let vested = 0n;
  for (let from = 0; from < Math.min(count, 500); from += 100) {
    const page = await viewFunction<StreamOnChain[]>(config.payday, "streams_of", {
      account_id: accountId,
      from_index: from,
      limit: 100,
    });
    for (const s of page) if (s.worker === accountId) vested += BigInt(s.withdrawable);
  }
  return balance + owed + vested;
}
