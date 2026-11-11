import { CASH_OUT_ASSETS, config } from "@/lib/config";

const ONE_CLICK = "https://1click.chaindefuser.com/v0";

/**
 * Proxies 1Click quotes so the optional JWT stays on the server. On testnet the quote
 * is always a dry run: prices are real mainnet prices, but no deposit address is issued.
 */
export async function POST(req: Request) {
  let body: { amount?: string; destination?: string; recipient?: string; refundTo?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const { amount, destination, recipient, refundTo } = body;
  if (!amount || !/^\d+$/.test(amount)) return Response.json({ error: "amount (base units) is required" }, { status: 400 });
  if (!CASH_OUT_ASSETS.some((a) => a.id === destination)) {
    return Response.json({ error: "Unsupported destination" }, { status: 400 });
  }
  if (!recipient) return Response.json({ error: "recipient address is required" }, { status: 400 });

  const dry = config.networkId !== "mainnet";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.ONE_CLICK_JWT) headers.Authorization = `Bearer ${process.env.ONE_CLICK_JWT}`;

  const res = await fetch(`${ONE_CLICK}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: config.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: destination,
      amount,
      // Refunds go back to the worker's NEAR account. On testnet this is only quoted.
      refundTo: dry ? "intents.near" : refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  const data = await res.json();
  if (!res.ok) return Response.json({ error: data?.message ?? "Quote failed" }, { status: res.status });
  return Response.json({ dry, quote: data.quote });
}

/** Status of a cash-out by its 1Click deposit address. */
export async function GET(req: Request) {
  const depositAddress = new URL(req.url).searchParams.get("depositAddress");
  if (!depositAddress) return Response.json({ error: "depositAddress is required" }, { status: 400 });
  const res = await fetch(`${ONE_CLICK}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  return Response.json(await res.json(), { status: res.status });
}
