import { IMPLICIT_ACCOUNT } from "@/lib/address";
import { ONE_USDC, config } from "@/lib/config";
import { usdcBalanceOf } from "@/lib/server/chain";
import { HttpError, clientIp, handle, readJson } from "@/lib/server/http";
import { rateLimiter } from "@/lib/server/limits";
import { spend } from "@/lib/server/relayer";

const GRANT = 5_000n * ONE_USDC;
/** Accounts holding at least this much already have enough to try Payday. */
const ENOUGH = 1_000n * ONE_USDC;
const MINT_GAS = 30_000_000_000_000n;
const perIp = rateLimiter({ id: "faucet-ip", label: "test USDC", limit: 3, windowMs: 60 * 60_000 });

/**
 * Test networks only: mints mock USDC straight to a browser account, which need not
 * exist yet (a token balance can exist before its account does).
 */
export function POST(req: Request) {
  return handle("faucet", async () => {
    if (!config.hasFaucet) throw new HttpError(404, "There is no faucet on this network");
    await perIp(clientIp(req));
    const body = await readJson(req, 256);
    const accountId = body.accountId;
    if (typeof accountId !== "string" || !IMPLICIT_ACCOUNT.test(accountId)) {
      throw new HttpError(400, "accountId must be a Payday account");
    }
    if ((await usdcBalanceOf(accountId)) >= ENOUGH) {
      throw new HttpError(409, "This account already has plenty of test USDC");
    }
    const res = await spend((relayer) =>
      relayer.callFunctionRaw({
        contractId: config.usdc,
        methodName: "mint",
        args: { account_id: accountId, amount: GRANT.toString() },
        gas: MINT_GAS,
      }),
    );
    return Response.json({ minted: GRANT.toString(), txHash: res.transaction.hash });
  });
}
