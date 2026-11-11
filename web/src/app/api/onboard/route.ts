import { ONE_USDC } from "@/lib/config";
import { owedOf, streamCountOf, usdcBalanceOf, viewAccount } from "@/lib/server/chain";
import { HttpError, clientIp, handle, readJson } from "@/lib/server/http";
import { rateLimiter } from "@/lib/server/limits";
import { implicitAccountId, spend } from "@/lib/server/relayer";

/**
 * Creating an implicit account takes any non-zero transfer, and accounts this small need
 * no balance for storage, so 1 yoctoNEAR creates it with nothing to take back out.
 */
const SEED_YOCTO = 1n;
const perIp = rateLimiter("account", 10, 60 * 60_000);
/**
 * Accounts this instance seeded in the last 10 minutes. Existence is read from final
 * state, which lags a fresh transfer, so this stops a burst for one key paying twice.
 */
const recentlySeeded = new Map<string, number>();
const SEED_MEMORY_MS = 10 * 60_000;

/** Only accounts with something on-chain to protect are worth an account-creation fee. */
async function hasValue(accountId: string): Promise<boolean> {
  const [streams, owed, balance] = await Promise.all([streamCountOf(accountId), owedOf(accountId), usdcBalanceOf(accountId)]);
  return streams > 0 || owed > 0n || balance >= ONE_USDC;
}

/**
 * Creates the implicit account for a browser key so it can sign. Payday pays the
 * account-creation fee once, for accounts that already hold USDC, have a salary stream
 * or are owed money.
 */
export function POST(req: Request) {
  return handle("onboard", async () => {
    perIp(clientIp(req));
    const body = await readJson(req, 512);
    const accountId = implicitAccountId(body.publicKey);

    const seededAt = recentlySeeded.get(accountId);
    if (seededAt && Date.now() - seededAt < SEED_MEMORY_MS) return Response.json({ accountId, created: false });
    if (await viewAccount(accountId)) return Response.json({ accountId, created: false });
    if (recentlySeeded.has(accountId)) return Response.json({ accountId, created: false });
    if (!(await hasValue(accountId))) {
      throw new HttpError(403, "This account has nothing to manage yet. It is set up once it holds USDC or a salary.");
    }

    const now = Date.now();
    for (const [id, at] of recentlySeeded) if (now - at >= SEED_MEMORY_MS) recentlySeeded.delete(id);
    recentlySeeded.set(accountId, now);
    try {
      const res = await spend((relayer) => relayer.transfer({ receiverId: accountId, amount: SEED_YOCTO }));
      return Response.json({ accountId, created: true, txHash: res.transaction.hash });
    } catch (e) {
      recentlySeeded.delete(accountId);
      throw e;
    }
  });
}
