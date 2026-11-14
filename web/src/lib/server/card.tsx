import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { config } from "../config";
import { clientIp, HttpError } from "./http";
import { rateLimiter } from "./limits";

/** A 1200×630 link-preview card in the payslip's paper style. */
export interface CardContent {
  kicker: string;
  title: string;
  /** The big green figure, if there is one. */
  amount: string | null;
  caption: string;
  /** Bottom left: "Paid to alice.near", or a plain line when there is no account. */
  footer: { label: string; value: string } | string;
  /** The pill top right; "On NEAR testnet" by default. */
  badge?: string;
}

export const BRAND_CARD: CardContent = {
  kicker: "Payday",
  title: "Payday",
  amount: null,
  caption: "USDC payroll that pays every second",
  footer: "Streamed by the second, cash out to any chain",
};

export const CARD_CACHE = {
  day: "public, s-maxage=86400, stale-while-revalidate=604800",
  short: "public, s-maxage=600, stale-while-revalidate=3600",
  fallback: "public, s-maxage=300",
};

const SIZE = { width: 1200, height: 630 };
const INK = "#0c0c0d";
const PAPER = "#ffffff";
const RULE = "#e6e5e1";
/** Gold for money and live state; the deep shade for text, the bright one for fills. */
const GOLD = "#b77f06";
const GOLD_FILL = "#f0ad1d";
const perIp = rateLimiter({ id: "card-ip", label: "preview", limit: 60, windowMs: 60_000 });
const font = (file: string) => readFile(join(process.cwd(), "assets", file));
const geist = font("Geist-Regular.ttf");

function Picture({ card, host }: { card: CardContent; host: string }) {
  const longTitle = card.title.length > 32;
  return (
    <div
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: PAPER, color: INK, fontFamily: "Sans" }}
    >
      <div style={{ display: "flex", height: 14, background: GOLD_FILL }} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "52px 72px 56px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", width: 34, height: 34, borderRadius: 10, background: INK }} />
            <div style={{ display: "flex", fontSize: 26, opacity: 0.7 }}>{card.kicker}</div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 20px",
              borderRadius: 999,
              border: `2px solid ${RULE}`,
              color: INK,
            }}
          >
            <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, background: GOLD_FILL }} />
            {card.badge ?? `On NEAR ${config.networkId}`}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: longTitle ? 52 : 68, lineHeight: 1.08, letterSpacing: -2 }}>{card.title}</div>
          {card.amount ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 124, lineHeight: 1.1, letterSpacing: -5, color: GOLD, marginTop: 8 }}>
                {card.amount}
              </div>
              <div style={{ display: "flex", fontSize: 30, marginTop: 12, opacity: 0.75 }}>{card.caption}</div>
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: 56, letterSpacing: -2, marginTop: 20, color: GOLD }}>{card.caption}</div>
          )}
        </div>

        <div style={{ display: "flex", borderTop: `2px solid ${RULE}`, paddingTop: 24, justifyContent: "space-between", fontSize: 26 }}>
          {typeof card.footer === "string" ? (
            <div style={{ display: "flex", opacity: 0.6 }}>{card.footer}</div>
          ) : (
            <div style={{ display: "flex" }}>
              <span style={{ opacity: 0.6, marginRight: 14 }}>{card.footer.label}</span>
              <span>{card.footer.value}</span>
            </div>
          )}
          <div style={{ display: "flex", opacity: 0.6 }}>{host}</div>
        </div>
      </div>
    </div>
  );
}

export async function renderCard(card: CardContent, req: Request, cacheControl: string): Promise<Response> {
  const sans = await geist;
  return new ImageResponse(<Picture card={card} host={new URL(req.url).host} />, {
    ...SIZE,
    fonts: [{ name: "Sans", data: sans, weight: 400, style: "normal" }],
    headers: { "Cache-Control": cacheControl },
  });
}

/** Per-IP limit for card routes: a 429 response, or null to go ahead. */
export async function limitCards(req: Request): Promise<Response | null> {
  try {
    await perIp(clientIp(req));
    return null;
  } catch (e) {
    if (e instanceof HttpError) return new Response(e.message, { status: e.status });
    throw e;
  }
}
