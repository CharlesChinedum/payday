import { parseRates, type Rates } from "@/lib/rates";
import { HttpError, clientIp, handle } from "@/lib/server/http";
import { rateLimiter } from "@/lib/server/limits";

/** ExchangeRate-API's open endpoint: free, no key, updated daily, attribution required. */
const SOURCE = "https://open.er-api.com/v6/latest/USD";
const TTL_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 8_000;
/** After a failed refresh, keep serving the stale copy and try again this much later. */
const RETRY_MS = 10 * 60_000;
const perIp = rateLimiter({ id: "rates-ip", label: "rates", limit: 60, windowMs: 60_000 });

let cached: { at: number; rates: Rates } | null = null;

async function fetchRates(): Promise<Rates> {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new Error(`rates upstream ${res.status}`);
  return parseRates(await res.json());
}

/**
 * USD exchange rates for the currencies Payday shows, fetched at most every six hours per
 * server and cached at the edge, so browsers never contact the provider and the CSP stays
 * closed. A stale copy is served if the provider is down.
 */
export function GET(req: Request) {
  return handle("rates", async () => {
    await perIp(clientIp(req));
    if (!cached || Date.now() - cached.at > TTL_MS) {
      try {
        cached = { at: Date.now(), rates: await fetchRates() };
      } catch (e) {
        console.error("[rates]", e);
        if (!cached) throw new HttpError(502, "Exchange rates are unavailable right now");
        cached = { ...cached, at: Date.now() - TTL_MS + RETRY_MS };
      }
    }
    return Response.json(cached.rates, {
      headers: { "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400" },
    });
  });
}
