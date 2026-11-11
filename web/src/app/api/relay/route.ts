import { config } from "@/lib/config";
import { decodeSignedDelegate, summarizeDelegate, verifyDelegateSignature } from "@/lib/delegate";
import { summarizeOutcome, type TxOutcome } from "@/lib/outcome";
import { checkDelegate } from "@/lib/policy";
import { HttpError, clientIp, handle, readJson, withTimeout } from "@/lib/server/http";
import { rateLimiter } from "@/lib/server/limits";
import { preflight } from "@/lib/server/preflight";
import { spend } from "@/lib/server/relayer";

export const maxDuration = 60;

const MAX_BODY_BYTES = 12 * 1024;
const RELAY_TIMEOUT_MS = 40_000;
const perIp = rateLimiter("relay", 30, 60_000);
const perSender = rateLimiter("relay", 20, 60_000);
const emitters = { payday: config.payday, nep141: config.usdc };

/**
 * Submits a user's signed delegate action and pays its gas, but only after proving it is
 * worth paying for: a sponsored call (policy), signed by the sender's own key
 * (signature), fresh and executable (pre-flight against chain state).
 */
export function POST(req: Request) {
  return handle("relay", async () => {
    perIp(clientIp(req));
    const body = await readJson(req, MAX_BODY_BYTES);
    if (typeof body.signedDelegate !== "string") throw new HttpError(400, "signedDelegate (base64) is required");

    let signed;
    try {
      signed = decodeSignedDelegate(Buffer.from(body.signedDelegate, "base64"));
    } catch {
      throw new HttpError(400, "signedDelegate is not a valid signed delegate action");
    }

    const summary = summarizeDelegate(signed);
    const verdict = checkDelegate(summary, { payday: config.payday, usdc: config.usdc });
    if (!verdict.ok) throw new HttpError(403, verdict.reason);
    const signature = verifyDelegateSignature(signed);
    if (!signature.ok) throw new HttpError(403, signature.reason);

    // Counted only now, so nobody can use up another account's allowance.
    perSender(summary.senderId);
    await preflight(summary, verdict.call);

    const outcome = await spend((relayer) =>
      withTimeout<TxOutcome | null>(
        relayer.relayMetaTransaction(signed).then((res) => summarizeOutcome(res as Parameters<typeof summarizeOutcome>[0], emitters)),
        RELAY_TIMEOUT_MS,
        () => null,
      ).catch((e: unknown) => {
        // Sent but not confirmed, or failed in a way we cannot classify: the caller must
        // re-read chain state rather than retry blindly.
        console.error("[relay] outcome unknown", e);
        return null;
      }),
    );
    if (!outcome) return Response.json({ status: "unknown" }, { status: 202 });
    return Response.json(outcome);
  });
}
