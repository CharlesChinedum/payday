import { describe, expect, it, vi } from "vitest";
import { actions, buildDelegateAction, encodeSignedDelegate, KeyPair, KeyPairSigner } from "near-api-js";

vi.mock("server-only", () => ({}));

const TGAS = 1_000_000_000_000n;

/** A withdraw signed by a brand-new key whose account was never created. */
async function throwawayDelegate(): Promise<string> {
  const key = KeyPair.fromRandom("ed25519");
  const senderId = Buffer.from(key.getPublicKey().ed25519Key!.data).toString("hex");
  const delegate = buildDelegateAction({
    senderId,
    receiverId: "app.payday-dev.testnet",
    actions: [actions.functionCall("withdraw", { stream_id: 1 }, 100n * TGAS, 0n)],
    nonce: 1n,
    maxBlockHeight: 1_100n,
    publicKey: key.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(key).signDelegateAction(delegate);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
}

const post = async (POST: (r: Request) => Promise<Response>, ip: string) =>
  POST(
    new Request("http://x/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ signedDelegate: await throwawayDelegate() }),
    }),
  );

describe("relay budget (review 3, S-1)", () => {
  it("is not used up by throwaway senders that the pre-flight refuses", async () => {
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "testnet");
    // The RPC: no such access key, chain height 1,000.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { params } = JSON.parse(String(init.body));
        if (params?.request_type === "view_access_key") return Response.json({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });
        return Response.json({ result: { header: { height: 1_000 } } });
      }),
    );
    const { POST } = await import("./route");
    const statuses = new Map<number, number>();
    // 2,000 refused requests from 67 IPs: more than the hourly ceiling.
    for (let i = 0; i < 2_000; i++) {
      const res = await post(POST, `10.0.${Math.floor(i / 30)}.1`);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
    expect(statuses.get(409)).toBe(2_000);
    // Someone else is still served: refused for their own reason, not by the exhausted budget.
    const next = await post(POST, "192.0.2.77");
    expect(next.status).toBe(409);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }, 60_000);
});
