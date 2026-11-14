import "server-only";
import { HttpError } from "./http";

const MAX_KEYS = 50_000;
const MAX_KEY_LENGTH = 128;
const SHARED_TIMEOUT_MS = 1_500;

/**
 * The shared store: Upstash Redis over its REST API, connected through the Vercel
 * Marketplace (either variable naming). Without it, every limit falls back to this
 * instance's memory alone.
 */
const store = (() => {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
})();

export const sharedLimitsEnabled = store !== null;

let warned = false;

/** Runs Redis commands in one round trip; null if the store is missing or failing. */
async function redis(commands: (string | number)[][]): Promise<unknown[] | null> {
  if (!store) return null;
  try {
    const res = await fetch(`${store.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${store.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(SHARED_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const replies = (await res.json()) as { result?: unknown; error?: string }[];
    const failed = replies.find((r) => r.error);
    if (failed) throw new Error(failed.error);
    return replies.map((r) => r.result);
  } catch (e) {
    // Degrade to per-instance limits rather than refuse everyone; the relayer balance
    // floor still stops all spending.
    if (!warned) console.error("[limits] shared store unavailable, using per-instance limits", e);
    warned = true;
    return null;
  }
}

function memoryWindow(windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();

  function sweep(now: number) {
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
    // Still full of live entries: drop the oldest rather than grow without bound.
    while (hits.size >= MAX_KEYS) hits.delete(hits.keys().next().value as string);
  }

  /** The count after this hit. */
  return (key: string): number => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      if (hits.size >= MAX_KEYS) sweep(now);
      hits.set(key, { count: 1, reset: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  };
}

export interface Limit {
  /** Unique per limiter: it namespaces the shared counters. */
  id: string;
  /** Used in the error: "Too many {label} requests". */
  label: string;
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window limiter. Each instance counts in memory first (free, and it still works if
 * the store is down), then the shared counter in Redis decides across every instance.
 */
export function rateLimiter({ id, label, limit, windowMs }: Limit) {
  const local = memoryWindow(windowMs);
  const refuse = () => new HttpError(429, `Too many ${label} requests; try again shortly`);

  return async (rawKey: string): Promise<void> => {
    const key = rawKey.slice(0, MAX_KEY_LENGTH);
    if (local(key) > limit) throw refuse();
    const shared = `rl:${id}:${Math.floor(Date.now() / windowMs)}:${key}`;
    const replies = await redis([
      ["INCR", shared],
      ["PEXPIRE", shared, windowMs * 2],
    ]);
    if (replies && Number(replies[0]) > limit) throw refuse();
  };
}

/**
 * A lock held across instances (and in memory, as the fallback): one relayed request per
 * sender at a time. Expires on its own if an instance dies holding it.
 */
export function sharedLock(id: string, ttlMs: number) {
  const held = new Set<string>();
  return {
    async acquire(key: string): Promise<boolean> {
      if (held.has(key)) return false;
      held.add(key);
      const replies = await redis([["SET", `lock:${id}:${key}`, "1", "NX", "PX", ttlMs]]);
      if (replies && replies[0] !== "OK") {
        held.delete(key);
        return false;
      }
      return true;
    },
    async release(key: string): Promise<void> {
      held.delete(key);
      await redis([["DEL", `lock:${id}:${key}`]]);
    },
  };
}
