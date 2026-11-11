import { describe, expect, it } from "vitest";
import { checkDelegate, type DelegateCall, type PolicyContext } from "./policy";
import { TGAS } from "./config";

const ctx: PolicyContext = { payday: "app.test", usdc: "usdc.test", allowMint: true };
const SENDER = "a".repeat(64);

function call(methodName: string, args: unknown = {}, gas = 30n * TGAS, deposit = 0n): DelegateCall {
  return { methodName, args, gas, deposit };
}

const check = (receiverId: string, ...calls: Array<DelegateCall | null>) =>
  checkDelegate({ senderId: SENDER, receiverId, calls }, ctx);

describe("checkDelegate", () => {
  it("sponsors withdraw, claim_owed and cancel on Payday", () => {
    expect(check("app.test", call("withdraw", { stream_id: 1 }, 50n * TGAS))).toEqual({ ok: true });
    expect(check("app.test", call("claim_owed"))).toEqual({ ok: true });
    expect(check("app.test", call("cancel", { stream_id: 1 }, 40n * TGAS))).toEqual({ ok: true });
  });

  it("rejects other receivers", () => {
    expect(check("evil.test", call("withdraw"))).toMatchObject({ ok: false });
  });

  it("rejects unknown and inherited method names", () => {
    expect(check("app.test", call("new"))).toMatchObject({ ok: false });
    expect(check("app.test", call("constructor"))).toMatchObject({ ok: false });
    expect(check("app.test", call("toString"))).toMatchObject({ ok: false });
  });

  it("rejects non-function-call actions and batches", () => {
    expect(check("app.test", null)).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw"), call("withdraw"))).toMatchObject({ ok: false });
    expect(check("app.test")).toMatchObject({ ok: false });
  });

  it("caps gas and pins the deposit", () => {
    expect(check("app.test", call("withdraw", {}, 51n * TGAS))).toMatchObject({ ok: false });
    expect(check("app.test", call("withdraw", {}, 40n * TGAS, 1n))).toMatchObject({ ok: false });
  });

  it("only sponsors token transfers that fund Payday", () => {
    const fund = (receiver_id: string) =>
      check("usdc.test", call("ft_transfer_call", { receiver_id, amount: "1", msg: "{}" }, 250n * TGAS, 1n));
    expect(fund("app.test")).toEqual({ ok: true });
    expect(fund("thief.test")).toMatchObject({ ok: false, reason: "Token transfers may only fund Payday" });
    expect(check("usdc.test", call("ft_transfer", { receiver_id: "app.test" }, 30n * TGAS, 1n))).toMatchObject({
      ok: false,
    });
  });

  it("only sponsors minting to the sender, and only when enabled", () => {
    expect(check("usdc.test", call("mint", { account_id: SENDER, amount: "1" }))).toEqual({ ok: true });
    expect(check("usdc.test", call("mint", { account_id: "other.test", amount: "1" }))).toMatchObject({ ok: false });
    expect(
      checkDelegate(
        { senderId: SENDER, receiverId: "usdc.test", calls: [call("mint", { account_id: SENDER })] },
        { ...ctx, allowMint: false },
      ),
    ).toMatchObject({ ok: false, reason: "Minting is disabled on this network" });
  });

  it("rejects non-JSON arguments where they are inspected", () => {
    expect(check("usdc.test", call("ft_transfer_call", "not-json", 250n * TGAS, 1n))).toMatchObject({ ok: false });
  });
});
