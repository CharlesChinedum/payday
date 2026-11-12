import "server-only";
import { randomUUID } from "node:crypto";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Uncaught errors are logged with an id and answered generically: no library or RPC
 * detail reaches the caller. */
export function handle(route: string, run: () => Promise<Response>): Promise<Response> {
  return run().catch((e: unknown) => {
    if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
    const id = randomUUID().slice(0, 8);
    console.error(`[${route}] ${id}`, e);
    return Response.json({ error: `Something went wrong (ref ${id}). Please try again.` }, { status: 500 });
  });
}

/**
 * Rejects requests a browser on another site could send: anything that is not
 * `application/json` (which forces a CORS preflight) or that names another origin.
 * Non-browser clients send neither header and are governed by rate limits instead.
 */
function assertSameOrigin(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "Cross-site requests are not accepted");
  }
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    throw new HttpError(403, "Cross-site requests are not accepted");
  }
}

/** Reads a small JSON object body, refusing anything larger than `maxBytes`. */
export async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  assertSameOrigin(req);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "Request too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Vercel sets x-forwarded-for itself; on any other host put a trusted proxy in front. */
/**
 * The rate-limit key for a request's client. IPv6 clients usually hold a whole /64, so
 * they are keyed by it; keying by the full address would give each one 2^64 allowances.
 */
export function clientIp(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || "local";
  return ip.includes(":") ? ipv6Prefix(ip) : ip;
}

/** The first four groups of an IPv6 address, expanding `::`; malformed input is kept whole. */
export function ipv6Prefix(ip: string): string {
  const addr = ip.replace(/^\[|\](:\d+)?$/g, "").split("%")[0].toLowerCase();
  const [head, tail, ...rest] = addr.split("::");
  if (rest.length) return addr;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 && !groups.at(-1)?.includes(".")) return addr;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Races `work` against a timeout; `onTimeout` decides what the caller gets instead. */
export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
