import "server-only";
import { Account, JsonRpcProvider, PublicKey, type KeyPairString } from "near-api-js";
import { config } from "../config";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

let relayer: Account | undefined;

export function relayerAccount(): Account {
  if (relayer) return relayer;
  const accountId = process.env.RELAYER_ACCOUNT_ID;
  const key = process.env.RELAYER_PRIVATE_KEY as KeyPairString | undefined;
  if (!accountId || !key) throw new Error("RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY must be set");
  relayer = new Account(accountId, provider, key);
  return relayer;
}

/** The implicit account id controlled by an ed25519 public key: its 32 bytes in hex. */
export function implicitAccountId(publicKey: string): string {
  const key = PublicKey.fromString(publicKey);
  if (!key.ed25519Key) throw new Error("Only ed25519 keys are supported");
  return Buffer.from(key.ed25519Key.data).toString("hex");
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fixed-window limiter, per process. Enough to stop a single client from draining the
 * relayer in a hackathon deployment; a production relayer needs shared storage.
 */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}
