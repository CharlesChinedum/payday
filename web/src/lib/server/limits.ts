import "server-only";
import { HttpError } from "./http";

const MAX_KEYS = 50_000;
const MAX_KEY_LENGTH = 128;

/**
 * Fixed-window limiter held in this server instance's memory. It is the inner layer:
 * Vercel Firewall rate limits are the outer, shared one, and the relayer balance floor
 * is the global stop. Expired entries are evicted so memory stays bounded.
 */
export function rateLimiter(name: string, limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();

  function sweep(now: number) {
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
    // Still full of live entries: drop the oldest rather than grow without bound.
    while (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value as string);
  }

  return (rawKey: string): void => {
    const key = rawKey.slice(0, MAX_KEY_LENGTH);
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      if (hits.size >= MAX_KEYS) sweep(now);
      hits.set(key, { count: 1, reset: now + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > limit) throw new HttpError(429, `Too many ${name} requests; try again shortly`);
  };
}
