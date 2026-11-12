import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { isNearAccountId, shortId } from "@/lib/address";
import { config } from "@/lib/config";
import { HIDE_AMOUNT, monthOf, monthPeriod, payslipLines, shareCard, type ShareCard } from "@/lib/payslip";
import { clientIp, HttpError } from "@/lib/server/http";
import { streamsOf } from "@/lib/server/chain";
import { rateLimiter } from "@/lib/server/limits";

const SIZE = { width: 1200, height: 630 };
const INK = "#14211b";
const PAPER = "#f8f5ea";
const RULE = "#cfc9b6";
const ACCENT = "#0a6847";
const perIp = rateLimiter("preview", 60, 60_000);
const font = (file: string) => readFile(join(process.cwd(), "assets", file));
const fonts = Promise.all([font("Geist-Regular.ttf"), font("InstrumentSerif-Regular.woff")]);

/** Past months never change; the current one moves every second, so previews refresh often. */
const CACHE = {
  past: "public, s-maxage=86400, stale-while-revalidate=604800",
  current: "public, s-maxage=600, stale-while-revalidate=3600",
  fallback: "public, s-maxage=300",
};

interface Card extends ShareCard {
  worker: string | null;
}

const BRAND: Card = { title: "Payday", amount: null, caption: "USDC payroll that pays every second", worker: null };

function Picture({ card, host }: { card: Card; host: string }) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: PAPER, color: INK, fontFamily: "Sans" }}
    >
      <div style={{ display: "flex", height: 14, background: ACCENT }} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "52px 72px 56px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 24 }}>
          <div style={{ display: "flex", letterSpacing: 5 }}>{card.worker ? "PAYSLIP · PAYDAY" : "PAYDAY"}</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 20px",
              borderRadius: 999,
              border: `2px solid ${ACCENT}`,
              color: ACCENT,
            }}
          >
            <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, background: ACCENT }} />
            Read live from NEAR {config.networkId}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontFamily: "Serif", fontSize: 76, lineHeight: 1 }}>{card.title}</div>
          {card.amount ? (
            <div style={{ display: "flex", fontFamily: "Serif", fontSize: 132, lineHeight: 1.1, color: ACCENT, marginTop: 8 }}>
              {card.amount}
            </div>
          ) : null}
          {card.amount ? (
            <div style={{ display: "flex", fontSize: 30, marginTop: 12, opacity: 0.75 }}>{card.caption}</div>
          ) : (
            <div style={{ display: "flex", fontFamily: "Serif", fontSize: 64, marginTop: 20, color: ACCENT }}>{card.caption}</div>
          )}
        </div>

        <div style={{ display: "flex", borderTop: `3px dashed ${RULE}`, paddingTop: 24, justifyContent: "space-between", fontSize: 26 }}>
          {card.worker ? (
            <div style={{ display: "flex" }}>
              <span style={{ opacity: 0.6, marginRight: 14 }}>Paid to</span>
              <span>{card.worker}</span>
            </div>
          ) : (
            <div style={{ display: "flex", opacity: 0.6 }}>Streamed by the second, cash out to any chain</div>
          )}
          <div style={{ display: "flex", opacity: 0.6 }}>{host}</div>
        </div>
      </div>
    </div>
  );
}

async function render(card: Card, host: string, cacheControl: string, status = 200) {
  const [sans, serif] = await fonts;
  const image = new ImageResponse(<Picture card={card} host={host} />, {
    ...SIZE,
    status,
    fonts: [
      { name: "Sans", data: sans, weight: 400, style: "normal" },
      { name: "Serif", data: serif, weight: 400, style: "normal" },
    ],
    headers: { "Cache-Control": cacheControl },
  });
  return image;
}

/**
 * The picture shown when a payslip link is shared on X, WhatsApp or Telegram: the month,
 * what was earned and who was paid, read from the chain like the payslip itself. With
 * `amount=hide` it leaves the figure out. Bad links get the plain Payday card, never an error.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    perIp(clientIp(req));
  } catch (e) {
    if (e instanceof HttpError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const worker = url.searchParams.get("worker")?.trim().toLowerCase() ?? "";
  const nowSecs = Math.floor(Date.now() / 1000);
  const period = monthPeriod(url.searchParams.get("month") ?? monthOf(nowSecs), nowSecs);
  if (!isNearAccountId(worker) || !period) return render(BRAND, url.host, CACHE.fallback);

  try {
    const lines = payslipLines(await streamsOf(worker), worker, period);
    const card = { ...shareCard(lines, period, url.searchParams.get("amount") === HIDE_AMOUNT), worker: shortId(worker) };
    return render(card, url.host, period.toDate ? CACHE.current : CACHE.past);
  } catch (e) {
    console.error("[preview]", e);
    return render(BRAND, url.host, "no-store");
  }
}
