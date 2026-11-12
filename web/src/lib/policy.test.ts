import { describe, expect, it } from "vitest";
import { checkDelegate, type DelegateCall, type DelegateSummary, type PolicyContext } from "./policy";
import { TGAS } from "./config";

const ctx: PolicyContext = { payday: "app.test", usdc: "usdc.test" };
const SENDER = "a".repeat(64);
const PAYOUT = 100n * TGAS;
const FUNDING = 150n * TGAS;

function call(methodName: string, args: unknown = {}, gas = PAYOUT, deposit = 0n): DelegateCall {
  return { methodName, args, gas, deposit };
}

function summary(receiverId: string, ...calls: Array<DelegateCall | null>): DelegateSummary {
  return { senderId: SENDER, receiverId, publicKey: "ed25519:x", nonce: 1n, maxBlockHeight: 1n, calls };
}

const check = (receiverId: string, ...calls: Array<DelegateCall | null>) => checkDelegate(summary(receiverId, ...calls), ctx);

const transfer = (args: Record<string, unknown>) => check("usdc.test", call("ft_transfer_call", args, FUNDING, 1n));
const fundMsg = (streams: unknown[]) => JSON.stringify({ streams });
const stream = { worker: "bob.test", amount: "1000000", start: 1, stop: 2 };

describe("checkDelegate", () => {
  it("parses sponsored Payday calls into typed calls", () => {
    expect(check("app.test", call("withdraw", { stream_id: 3 }))).toEqual({
      ok: true,
      call: { kind: "withdraw", streamId: 3, amount: null, receiver: null },
    });
    expect(check("app.test", call("withdraw", { stream_id: 3, amount: "500", receiver: "bob.test" }))).toEqual({
      ok: true,
      call: { kind: "withdraw", streamId: 3, amount: 500n, receiver: "bob.test" },
    });
    expect(check("app.test", call("claim_owed", {}))).toEqual({ ok: true, call: { kind: "claim_owed", receiver: null } });
    expect(check("app.test", call("cancel", { stream_id: 9 }))).toEqual({ ok: true, call: { kind: "cancel", streamId: 9 } });
  });

  it("parses funding and send transfers to Payday", () => {
    expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: fundMsg([stream]) })).toEqual({
      ok: true,
      call: { kind: "fund", amount: 1_010_000n, streams: [{ worker: "bob.test", amount: 1_000_000n, start: 1, stop: 2 }] },
    });
    expect(transfer({ receiver_id: "app.test", amount: "2000000", msg: JSON.stringify({ send_to: "bob.test" }) })).toEqual({
      ok: true,
      call: { kind: "send", amount: 2_000_000n, sendTo: "bob.test" },
    });
  });

  it("rejects other receivers, methods, actions and batches", () => {
    expect(check("evil.test", call("withdraw", { stream_id: 1 }))).toMatchObject({ ok: false });
    for (const m of ["new", "upgrade", "set_fees", "prune", "constructor", "toString"]) {
      expect(check("app.test", call(m))).toMatchObject({ ok: false });
    }
    expect(check("usdc.test", call("mint", { account_id: SENDER, amount: "1" }))).toMatchObject({ ok: false });
    expect(check("usdc.test", call("ft_transfer", { receiver_id: "app.test", amount: "1" }, PAYOUT, 1n))).toMatchObject({ ok: false });
    expect(check("app.test", null)).toMatchObject({ ok: false });
    expect(check("app.test", call("cancel", { stream_id: 1 }), call("cancel", { stream_id: 2 }))).toMatchObject({ ok: false });
    expect(check("app.test")).toMatchObject({ ok: false });
  });

  it("pins gas and deposits, so the relayer never pays an attached deposit beyond 1 yocto", () => {
    expect(check("app.test", call("withdraw", { stream_id: 1 }, PAYOUT + 1n))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", { stream_id: 1 }, 40n * TGAS))).toMatchObject({
      ok: false,
      reason: "Gas must be exactly 100 Tgas",
    });
    expect(check("app.test", call("withdraw", { stream_id: 1 }, PAYOUT, 1n))).toMatchObject({ ok: false });
    expect(check("usdc.test", call("ft_transfer_call", { receiver_id: "app.test", amount: "1000000", msg: fundMsg([stream]) }, FUNDING, 2n))).toMatchObject({ ok: false });
  });

  it("rejects unexpected, missing and malformed arguments", () => {
    expect(check("app.test", call("withdraw", { stream_id: 1, extra: true }))).toMatchObject({ ok: false, reason: "Unexpected argument extra" });
    expect(check("app.test", call("withdraw", {}))).toMatchObject({ ok: false, reason: "Missing argument stream_id" });
    expect(check("app.test", call("withdraw", { stream_id: "1" }))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", { stream_id: 0 }))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", { stream_id: 1, amount: "1,000" }))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", { stream_id: 1, receiver: "Not An Account" }))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", "not-json"))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", [1]))).toMatchObject({ ok: false });
  });

  it("only sponsors transfers that fund or send through Payday", () => {
    expect(transfer({ receiver_id: "thief.test", amount: "1010000", msg: fundMsg([stream]) })).toMatchObject({
      ok: false,
      reason: "Token transfers may only go to Payday",
    });
    expect(transfer({ receiver_id: "app.test", amount: "10", msg: fundMsg([stream]) })).toMatchObject({ ok: false });
    expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: "{" })).toMatchObject({ ok: false });
    expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: fundMsg([]) })).toMatchObject({ ok: false });
    expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: fundMsg(Array(26).fill(stream)) })).toMatchObject({ ok: false });
    expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: fundMsg([{ ...stream, extra: 1 }]) })).toMatchObject({ ok: false });
    expect(
      transfer({ receiver_id: "app.test", amount: "1010000", msg: JSON.stringify({ streams: [stream], send_to: "bob.test" }) }),
    ).toMatchObject({ ok: false });
  });

  it("refuses Payday and the token as receivers, which the contract would reject", () => {
    for (const receiver of ["app.test", "usdc.test"]) {
      expect(check("app.test", call("withdraw", { stream_id: 1, receiver }))).toMatchObject({ ok: false });
      expect(check("app.test", call("claim_owed", { receiver }))).toMatchObject({ ok: false });
      expect(transfer({ receiver_id: "app.test", amount: "2000000", msg: JSON.stringify({ send_to: receiver }) })).toMatchObject({ ok: false });
      expect(transfer({ receiver_id: "app.test", amount: "1010000", msg: fundMsg([{ ...stream, worker: receiver }]) })).toMatchObject({
        ok: false,
      });
    }
  });

  it("accepts only a short string memo", () => {
    const base = { receiver_id: "app.test", amount: "2000000", msg: JSON.stringify({ send_to: "bob.test" }) };
    expect(transfer({ ...base, memo: null })).toMatchObject({ ok: true });
    expect(transfer({ ...base, memo: "payroll" })).toMatchObject({ ok: true });
    expect(transfer({ ...base, memo: { nested: true } })).toMatchObject({ ok: false, reason: "Invalid memo" });
    expect(transfer({ ...base, memo: "x".repeat(65) })).toMatchObject({ ok: false, reason: "Invalid memo" });
  });
});
