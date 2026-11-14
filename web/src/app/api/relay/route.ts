import { config } from "@/lib/config";
import { decodeSignedDelegate, summarizeDelegate, verifyDelegateSignature } from "@/lib/delegate";
import { summarizeOutcome, type TxOutcome } from "@/lib/outcome";
import { checkDelegate, type DelegateSummary, type SponsoredCall } from "@/lib/policy";
import type { SignedDelegate } from "near-api-js";
import { HttpError, clientIp, handle, readJson, withTimeout } from "@/lib/server/http";
import { rateLimiter, sharedLock } from "@/lib/server/limits";
import { preflight } from "@/lib/server/preflight";
import { spend } from "@/lib/server/relayer";

export const maxDuration = 60;

const MAX_BODY_BYTES = 12 * 1024;
const RELAY_TIMEOUT_MS = 40_000;
const perIp = rateLimiter({ id: "relay-ip", label: "relay", limit: 30, windowMs: 60_000 });
const perSender = rateLimiter({ id: "relay-sender", label: "relay", limit: 20, windowMs: 60_000 });
/** Every instance together: a ceiling on relays the relayer actually pays for, per hour. */
const overall = rateLimiter({ id: "relay-all", label: "relay", limit: 2_000, windowMs: 60 * 60_000 });
const emitters = { payday: config.payday, nep141: config.usdc };
/**
 * Senders with a delegate being relayed, across every instance. Two parallel copies of one
 * request would both pass the pre-flight, and the second would fail on-chain at the
 * relayer's cost, so each sender gets one at a time.
 */
const inFlight = sharedLock("relay", RELAY_TIMEOUT_MS + 20_000);

/**
 * Submits a user's signed delegate action and pays its gas, but only after proving it is
 * worth paying for: a sponsored call (policy), signed by the sender's own key
 * (signature), fresh and executable (pre-flight against chain state).
 */
export function POST(req: Request) {
  return handle("relay", async () => {
    await perIp(clientIp(req));
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
    await perSender(summary.senderId);
    // One at a time per sender, and per stream: an employer and a worker cancelling the same
    // stream together would both pass the pre-flight, and the second would fail on-chain.
    const locks = [summary.senderId, ...("streamId" in verdict.call ? [`stream:${verdict.call.streamId}`] : [])];
    const held: string[] = [];
    try {
      for (const key of locks) {
        if (!(await inFlight.acquire(key))) throw new HttpError(409, "A request for this is still being sent; wait a moment");
        held.push(key);
      }
      return await relay(summary, verdict.call, signed);
    } finally {
      for (const key of held) await inFlight.release(key);
    }
  });
}

/** Pre-flights the delegate, then submits it and pays for it. */
async function relay(summary: DelegateSummary, call: SponsoredCall, signed: SignedDelegate): Promise<Response> {
  await preflight(summary, call);
  // Counted only for requests the relayer will pay for, so throwaway keys that fail the
  // pre-flight cannot use up everyone's budget (review 3, S-1).
  await overall("all");

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
}
