import { IMPLICIT_ACCOUNT, checkAddress } from "@/lib/address";
import { CASH_OUT_ASSETS, ONE_USDC, config } from "@/lib/config";
import { spendableOf } from "@/lib/server/chain";
import { HttpError, clientIp, handle, readJson } from "@/lib/server/http";
import { rateLimiter } from "@/lib/server/limits";

const ONE_CLICK = "https://1click.chaindefuser.com/v0";
const UPSTREAM_TIMEOUT_MS = 10_000;
const QUOTE_TTL_MS = 30 * 60_000;
const U128 = /^(0|[1-9]\d{0,38})$/;
const perIpQuote = rateLimiter("quote", 20, 60_000);
const perIpStatus = rateLimiter("status", 60, 60_000);

interface OneClickQuote {
  quote?: {
    amountIn?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    minAmountOut?: string;
    timeEstimate?: number;
    depositAddress?: string;
  };
  quoteRequest?: Record<string, unknown>;
  message?: string;
}

async function upstream(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONE_CLICK_JWT) headers.Authorization = `Bearer ${process.env.ONE_CLICK_JWT}`;
  try {
    const res = await fetch(`${ONE_CLICK}${path}`, { ...init, headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    return { status: res.status, body: await res.json() };
  } catch (e) {
    console.error("[quote] upstream", e);
    throw new HttpError(502, "The cash-out service is not responding; try again shortly");
  }
}

/**
 * Proxies 1Click quotes so the partner JWT stays on the server, and checks both sides:
 * the request must be a real cash-out for a Payday account that can afford it, and the
 * answer must be for exactly what was asked. On test networks the quote is a dry run:
 * real prices, but no deposit address.
 */
export function POST(req: Request) {
  return handle("quote", async () => {
    perIpQuote(clientIp(req));
    const body = await readJson(req, 1024);
    const asset = CASH_OUT_ASSETS.find((a) => a.id === body.destination);
    if (!asset) throw new HttpError(400, "Unsupported destination");
    const recipient = checkAddress(asset.kind, typeof body.recipient === "string" ? body.recipient : "");
    if (!recipient.ok) throw new HttpError(400, recipient.reason);
    const refundTo = body.refundTo;
    if (typeof refundTo !== "string" || !IMPLICIT_ACCOUNT.test(refundTo)) throw new HttpError(400, "refundTo must be a Payday account");
    if (typeof body.amount !== "string" || !U128.test(body.amount)) throw new HttpError(400, "amount must be USDC base units");
    const amount = BigInt(body.amount);
    if (amount < ONE_USDC) throw new HttpError(400, "Cash out at least 1 USDC");
    if (amount > (await spendableOf(refundTo))) throw new HttpError(400, "That is more than this account can cash out");

    const dry = config.networkId !== "mainnet";
    const deadline = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
    const request = {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: config.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: asset.id,
      amount: amount.toString(),
      // On test networks the quote is never executed; the refund address is a placeholder.
      refundTo: dry ? "intents.near" : refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: recipient.address,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    };
    const { status, body: reply } = await upstream("/quote", { method: "POST", body: JSON.stringify(request) });
    const data = reply as OneClickQuote;
    if (status !== 200) throw new HttpError(status >= 500 ? 502 : 400, data?.message ?? "Quote failed");

    const q = data.quote;
    const echo = data.quoteRequest ?? {};
    const sameRequest = (["amount", "destinationAsset", "recipient", "refundTo", "originAsset"] as const).every(
      (k) => echo[k] === request[k],
    );
    if (!q || q.amountIn !== request.amount || !sameRequest) {
      console.error("[quote] mismatched answer", JSON.stringify(data).slice(0, 500));
      throw new HttpError(502, "The cash-out service answered for a different request");
    }
    if (!dry && (!q.depositAddress || !IMPLICIT_ACCOUNT.test(q.depositAddress))) {
      throw new HttpError(502, "The cash-out service returned an unexpected deposit address");
    }
    if (![q.amountOut, q.minAmountOut].every((v) => typeof v === "string" && U128.test(v))) {
      throw new HttpError(502, "The cash-out service returned an unexpected quote");
    }
    return Response.json({
      dry,
      deadline,
      quote: {
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        amountOutFormatted: q.amountOutFormatted ?? "",
        minAmountOut: q.minAmountOut,
        timeEstimate: typeof q.timeEstimate === "number" ? q.timeEstimate : null,
        depositAddress: dry ? null : q.depositAddress,
      },
    });
  });
}

/** Status of a cash-out by its 1Click deposit address. */
export function GET(req: Request) {
  return handle("quote-status", async () => {
    perIpStatus(clientIp(req));
    const depositAddress = new URL(req.url).searchParams.get("depositAddress") ?? "";
    if (!IMPLICIT_ACCOUNT.test(depositAddress)) throw new HttpError(400, "depositAddress must be a NEAR implicit account");
    const { status, body } = await upstream(`/status?depositAddress=${depositAddress}`);
    if (status !== 200) throw new HttpError(502, "Status unavailable");
    const reported = (body as { status?: unknown }).status;
    return Response.json({ status: typeof reported === "string" ? reported.slice(0, 40) : null });
  });
}
