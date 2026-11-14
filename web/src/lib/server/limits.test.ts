import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Loads limits.ts fresh, with or without the shared store configured. */
async function load(shared: boolean) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (shared) {
    vi.stubEnv("KV_REST_API_URL", "https://redis.example/");
    vi.stubEnv("KV_REST_API_TOKEN", "test-token");
  } else {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  }
  return import("./limits");
}

/** A fake Upstash: counters and NX locks shared by every limiter, like separate instances. */
function fakeRedis() {
  const data = new Map<string, number | string>();
  const calls: unknown[][] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://redis.example/pipeline");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    const commands = JSON.parse(String(init.body)) as (string | number)[][];
    calls.push(...commands);
    const results = commands.map(([cmd, key, ...rest]) => {
      const k = String(key);
      if (cmd === "INCR") {
        const n = Number(data.get(k) ?? 0) + 1;
        data.set(k, n);
        return n;
      }
      if (cmd === "SET") {
        if (rest.includes("NX") && data.has(k)) return null;
        data.set(k, String(rest[0]));
        return "OK";
      }
      if (cmd === "DEL") return data.delete(k) ? 1 : 0;
      return 1;
    });
    return Response.json(results.map((result) => ({ result })));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("rate limits (H-04)", () => {
  it("count in memory when no shared store is configured", async () => {
    const { rateLimiter, sharedLimitsEnabled } = await load(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const limit = rateLimiter({ id: "t", label: "test", limit: 2, windowMs: 60_000 });
    await limit("a");
    await limit("a");
    await expect(limit("a")).rejects.toMatchObject({ status: 429, message: "Too many test requests; try again shortly" });
    await limit("b");
    expect(sharedLimitsEnabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("share one counter across instances", async () => {
    const { rateLimiter, sharedLimitsEnabled } = await load(true);
    const { calls } = fakeRedis();
    // Two limiters with the same id stand for two server instances.
    const one = rateLimiter({ id: "t", label: "test", limit: 3, windowMs: 60_000 });
    const two = rateLimiter({ id: "t", label: "test", limit: 3, windowMs: 60_000 });
    await one("a");
    await two("a");
    await one("a");
    await expect(two("a")).rejects.toMatchObject({ status: 429 });
    expect(sharedLimitsEnabled).toBe(true);
    expect(calls[1]).toEqual(["PEXPIRE", expect.stringMatching(/^rl:t:\d+:a$/), 120_000]);
    // Expiry is set once per window, and a refused key stops reaching the store.
    expect(calls.filter(([cmd]) => cmd === "PEXPIRE")).toHaveLength(1);
    const before = calls.length;
    await expect(one("a")).rejects.toMatchObject({ status: 429 });
    await expect(two("a")).rejects.toMatchObject({ status: 429 });
    expect(calls.length).toBe(before + 1);
  });

  it("fall back to memory when the store fails, instead of refusing everyone", async () => {
    const { rateLimiter } = await load(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const limit = rateLimiter({ id: "t", label: "test", limit: 1, windowMs: 60_000 });
    await limit("a");
    await expect(limit("a")).rejects.toMatchObject({ status: 429 });
  });

  it("hold one relay per sender across instances, and release it", async () => {
    const { sharedLock } = await load(true);
    fakeRedis();
    const one = sharedLock("relay", 60_000);
    const two = sharedLock("relay", 60_000);
    expect(await one.acquire("ada.near")).toBe(true);
    expect(await two.acquire("ada.near")).toBe(false);
    expect(await one.acquire("ada.near")).toBe(false);
    await one.release("ada.near");
    expect(await two.acquire("ada.near")).toBe(true);
  });
});
