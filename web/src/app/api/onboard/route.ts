import { parseNearAmount } from "near-api-js";
import { accountExists, clientIp, implicitAccountId, rateLimiter, relayerAccount } from "@/lib/server/relayer";

/** Covers the account's own storage plus the 1 yoctoNEAR deposits NEP-141 calls need. */
const SEED = BigInt(parseNearAmount("0.005")!);
const perIp = rateLimiter(5, 60 * 60_000);

/**
 * Creates the implicit account for a browser-generated key by sending it a little NEAR.
 * The user never buys NEAR; Payday sponsors this once per account.
 */
export async function POST(req: Request) {
  let publicKey: unknown;
  try {
    ({ publicKey } = await req.json());
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof publicKey !== "string") {
    return Response.json({ error: "publicKey is required" }, { status: 400 });
  }

  let accountId: string;
  try {
    accountId = implicitAccountId(publicKey);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Invalid public key" }, { status: 400 });
  }

  if (await accountExists(accountId)) return Response.json({ accountId, created: false });
  if (!perIp(clientIp(req))) {
    return Response.json({ error: "Too many new accounts from this address, try later" }, { status: 429 });
  }

  try {
    const res = await relayerAccount().transfer({ receiverId: accountId, amount: SEED });
    return Response.json({ accountId, created: true, txHash: res.transaction.hash });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
