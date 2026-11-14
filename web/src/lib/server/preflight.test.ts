import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegateSummary, SponsoredCall } from "../policy";
import type { StreamOnChain } from "./chain";

vi.mock("server-only", () => ({}));

const chain = vi.hoisted(() => ({
  height: 1_000n,
  keyNonce: 5n as bigint | null,
  streams: new Map<number, StreamOnChain>(),
  owed: 0n,
  balance: 0n,
  registered: new Set<string>(),
  paused: false,
}));

vi.mock("./chain", () => ({
  accessKeyNonce: async () => chain.keyNonce,
  blockHeight: async () => chain.height,
  getStream: async (id: number) => chain.streams.get(id) ?? null,
  owedOf: async () => chain.owed,
  usdcBalanceOf: async () => chain.balance,
  isRegistered: async (id: string) => chain.registered.has(id),
  paydayConfig: async () => ({ streamFee: 10_000n, registrationFee: 10_000n, payoutFee: 10_000n, paused: chain.paused }),
}));

const { preflight } = await import("./preflight");

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const USDC = 1_000_000n;
const now = () => Math.floor(Date.now() / 1000);

function delegate(over: Partial<DelegateSummary> = {}): DelegateSummary {
  return { senderId: ALICE, receiverId: "app.test", publicKey: "ed25519:x", nonce: 6n, maxBlockHeight: 1_100n, calls: [], ...over };
}

function stream(over: Partial<StreamOnChain> = {}): StreamOnChain {
  return {
    id: 1,
    employer: BOB,
    worker: ALICE,
    deposit: (100n * USDC).toString(),
    withdrawn: "0",
    withdrawable: (10n * USDC).toString(),
    start: now() - 100,
    stop: now() + 1_000,
    ...over,
  };
}

const run = (call: SponsoredCall, d = delegate()) => preflight(d, call);
const withdraw = (amount: bigint | null, receiver: string | null = null): SponsoredCall => ({
  kind: "withdraw",
  streamId: 1,
  amount,
  receiver,
});

beforeEach(() => {
  Object.assign(chain, { height: 1_000n, keyNonce: 5n, owed: 0n, balance: 0n, paused: false });
  chain.streams = new Map([[1, stream()]]);
  chain.registered = new Set([ALICE, BOB]);
});

describe("preflight: the delegate", () => {
  it("passes a fresh, short-lived delegate", async () => {
    await expect(run(withdraw(null))).resolves.toBeUndefined();
  });

  it("refuses replays, expired, long-lived and out-of-range nonces", async () => {
    await expect(run(withdraw(null), delegate({ nonce: 5n }))).rejects.toThrow("already used");
    await expect(run(withdraw(null), delegate({ maxBlockHeight: 1_000n }))).rejects.toThrow("expires too soon");
    // Review 3, S-2: one that would expire before its receipt runs is refused too.
    await expect(run(withdraw(null), delegate({ maxBlockHeight: 1_002n }))).rejects.toThrow("expires too soon");
    await expect(run(withdraw(null), delegate({ maxBlockHeight: 1_601n }))).rejects.toThrow("too long");
    await expect(run(withdraw(null), delegate({ nonce: 1_000n * 1_000_000n }))).rejects.toThrow("nonce is too large");
    chain.keyNonce = null;
    await expect(run(withdraw(null))).rejects.toThrow("not set up");
  });
});

describe("preflight: payouts must pay their own fees (N-01)", () => {
  it("refuses dust withdrawals that leave something in the stream", async () => {
    await expect(run(withdraw(USDC - 1n))).rejects.toThrow("at least 1 USDC");
    await expect(run(withdraw(USDC))).resolves.toBeUndefined();
  });

  it("allows a small withdrawal that empties the stream, if it covers the fees", async () => {
    chain.streams.set(1, stream({ withdrawn: (100n * USDC - 15_000n).toString(), withdrawable: "15000" }));
    await expect(run(withdraw(null))).resolves.toBeUndefined();
    await expect(run(withdraw(null, "fresh.test"))).rejects.toThrow("does not cover the fees");
    chain.streams.set(1, stream({ withdrawn: (100n * USDC - 10_000n).toString(), withdrawable: "10000" }));
    await expect(run(withdraw(null))).rejects.toThrow("does not cover the fees");
  });

  it("refuses withdrawals that are not the sender's or not vested", async () => {
    await expect(run(withdraw(11n * USDC))).rejects.toThrow("exceeds");
    chain.streams.set(1, stream({ worker: BOB }));
    await expect(run(withdraw(null))).rejects.toThrow("Only the worker");
    chain.streams.set(1, stream({ withdrawable: "0" }));
    await expect(run(withdraw(null))).rejects.toThrow("Nothing to withdraw");
  });

  it("refuses claims that cannot cover the fees", async () => {
    await expect(run({ kind: "claim_owed", receiver: null })).rejects.toThrow("Nothing to claim");
    chain.owed = 10_000n;
    await expect(run({ kind: "claim_owed", receiver: null })).rejects.toThrow("does not cover the fees");
    chain.owed = 15_000n;
    await expect(run({ kind: "claim_owed", receiver: null })).resolves.toBeUndefined();
    await expect(run({ kind: "claim_owed", receiver: BOB })).rejects.toThrow("at least 1 USDC");
  });

  it("refuses sends to yourself, beyond the balance or below the fees", async () => {
    chain.balance = 5n * USDC;
    await expect(run({ kind: "send", amount: USDC, sendTo: ALICE })).rejects.toThrow("yourself");
    await expect(run({ kind: "send", amount: 6n * USDC, sendTo: BOB })).rejects.toThrow("Not enough USDC");
    await expect(run({ kind: "send", amount: USDC, sendTo: BOB })).resolves.toBeUndefined();
  });
});

describe("preflight: cancel and fund", () => {
  it("refuses cancelling an ended stream or someone else's", async () => {
    await expect(run({ kind: "cancel", streamId: 1 })).resolves.toBeUndefined();
    chain.streams.set(1, stream({ worker: BOB, employer: BOB }));
    await expect(run({ kind: "cancel", streamId: 1 })).rejects.toThrow("Only the employer or worker");
    chain.streams.set(1, stream({ stop: now() + 30 }));
    await expect(run({ kind: "cancel", streamId: 1 })).rejects.toThrow("ends within a minute");
  });

  const fund = (s: Partial<{ worker: string; amount: bigint; start: number; stop: number }> = {}): SponsoredCall => {
    const st = { worker: BOB, amount: USDC, start: now(), stop: now() + 1_000, ...s };
    return { kind: "fund", amount: st.amount + 10_000n, streams: [st] };
  };

  it("replicates the contract's stream bounds", async () => {
    chain.balance = 10n * USDC;
    await expect(run(fund())).resolves.toBeUndefined();
    await expect(run(fund({ worker: ALICE }))).rejects.toThrow("cannot be the employer");
    await expect(run(fund({ amount: USDC - 1n }))).rejects.toThrow("at least 1 USDC");
    await expect(run(fund({ stop: now() - 10, start: now() - 100 }))).rejects.toThrow("stop in the future");
    await expect(run(fund({ start: now() + 400 * 86_400, stop: now() + 401 * 86_400 }))).rejects.toThrow("within a year");
    await expect(run(fund({ start: now(), stop: now() + 6 * 365 * 86_400 }))).rejects.toThrow("five years");
    await expect(run(fund({ start: Date.now(), stop: Date.now() + 1_000 }))).rejects.toThrow("within a year");
  });

  it("refuses funding that is paused, mis-totalled or unaffordable", async () => {
    chain.balance = 10n * USDC;
    const call = fund();
    await expect(run({ ...call, amount: USDC } as SponsoredCall)).rejects.toThrow("plus the stream fees");
    chain.balance = USDC;
    await expect(run(call)).rejects.toThrow("Not enough USDC");
    chain.paused = true;
    await expect(run(call)).rejects.toThrow("paused");
  });
});
