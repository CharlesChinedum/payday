import { isNearAccountId, shortId } from "@/lib/address";
import { config } from "@/lib/config";
import { HIDE_AMOUNT, monthOf, monthPeriod, payslipLines, shareCard } from "@/lib/payslip";
import { BRAND_CARD, CARD_CACHE, limitCards, renderCard } from "@/lib/server/card";
import { streamsOf } from "@/lib/server/chain";

/**
 * The picture shown when a payslip link is shared on X, WhatsApp or Telegram: the month,
 * what was earned and who was paid, read from the chain like the payslip itself. With
 * `amount=hide` it leaves the figure out. Bad links get the plain Payday card, never an error.
 */
export async function GET(req: Request) {
  const limited = await limitCards(req);
  if (limited) return limited;
  const url = new URL(req.url);
  const worker = url.searchParams.get("worker")?.trim().toLowerCase() ?? "";
  const nowSecs = Math.floor(Date.now() / 1000);
  const period = monthPeriod(url.searchParams.get("month") ?? monthOf(nowSecs), nowSecs);
  if (!isNearAccountId(worker) || !period) return renderCard(BRAND_CARD, req, CARD_CACHE.fallback);

  try {
    const lines = payslipLines(await streamsOf(worker), worker, period);
    const card = shareCard(lines, period, url.searchParams.get("amount") === HIDE_AMOUNT);
    return renderCard(
      {
        ...card,
        kicker: "PAYSLIP · PAYDAY",
        badge: `Read live from NEAR ${config.networkId}`,
        footer: { label: "Paid to", value: shortId(worker) },
      },
      req,
      period.toDate ? CARD_CACHE.short : CARD_CACHE.day,
    );
  } catch (e) {
    console.error("[preview]", e);
    return renderCard(BRAND_CARD, req, "no-store");
  }
}
