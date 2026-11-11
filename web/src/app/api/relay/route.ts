import { config } from "@/lib/config";
import { checkDelegate, type DelegateSummary } from "@/lib/policy";
import { clientIp, decodeSignedDelegate, rateLimiter, relayerAccount, summarize } from "@/lib/server/relayer";

const perSender = rateLimiter(20, 60_000);
const perIp = rateLimiter(60, 60_000);

function decodeArgs(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: { signedDelegate?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (typeof body.signedDelegate !== "string") {
    return Response.json({ error: "signedDelegate (base64) is required" }, { status: 400 });
  }

  let signed;
  try {
    signed = decodeSignedDelegate(Buffer.from(body.signedDelegate, "base64"));
  } catch {
    return Response.json({ error: "signedDelegate is not a valid signed delegate action" }, { status: 400 });
  }

  const { senderId, receiverId, actions } = signed.delegateAction;
  const summary: DelegateSummary = {
    senderId,
    receiverId,
    calls: actions.map((a) =>
      a.functionCall
        ? {
            methodName: a.functionCall.methodName,
            args: decodeArgs(a.functionCall.args),
            gas: a.functionCall.gas,
            deposit: a.functionCall.deposit,
          }
        : null,
    ),
  };
  const verdict = checkDelegate(summary, {
    payday: config.payday,
    usdc: config.usdc,
    allowMint: config.networkId === "testnet",
  });
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 403 });

  if (!perSender(senderId) || !perIp(clientIp(req))) {
    return Response.json({ error: "Too many requests, try again in a minute" }, { status: 429 });
  }

  try {
    const res = await relayerAccount().relayMetaTransaction(signed);
    return Response.json(summarize(res));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
