import { shortId } from "@/lib/address";
import { daysText, parseRequest, requestAmount } from "@/lib/request";
import { BRAND_CARD, CARD_CACHE, limitCards, renderCard } from "@/lib/server/card";

/**
 * The picture shown when a request-to-be-paid link is shared. Everything on it comes from
 * the link itself, so it never changes and caches for a day.
 */
export async function GET(req: Request) {
  const limited = limitCards(req);
  if (limited) return limited;
  const request = parseRequest(new URL(req.url).searchParams);
  if (!request) return renderCard(BRAND_CARD, req, CARD_CACHE.fallback);
  return renderCard(
    {
      kicker: "PAYMENT REQUEST · PAYDAY",
      title: request.note ? `“${request.note}”` : "Pay me by the second",
      amount: `${requestAmount(request.amount)} USDC`,
      caption: `Over ${daysText(request.days)}, streamed by the second. Open the link to fund it.`,
      footer: { label: "Pay to", value: shortId(request.worker) },
    },
    req,
    CARD_CACHE.day,
  );
}
