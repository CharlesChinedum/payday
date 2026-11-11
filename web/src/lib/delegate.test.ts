import { describe, expect, it } from "vitest";
import { KeyPair, Signature, actions, buildDelegateAction, encodeSignedDelegate } from "near-api-js";
import { decodeSignedDelegate, summarizeDelegate } from "./delegate";
import { checkDelegate } from "./policy";
import { TGAS } from "./config";

function signedBytes(receiverId: string, action: ReturnType<typeof actions.functionCall>) {
  const key = KeyPair.fromRandom("ed25519");
  const delegateAction = buildDelegateAction({
    senderId: "a".repeat(64),
    receiverId,
    actions: [action],
    nonce: 7n,
    maxBlockHeight: 1000n,
    publicKey: key.getPublicKey(),
  });
  const signature = new Signature({ keyType: 0, data: new Uint8Array(64) });
  const wrapped = actions.signedDelegate({ delegateAction, signature });
  return encodeSignedDelegate(wrapped.signedDelegate!);
}

describe("signed delegate decoding", () => {
  it("round-trips a function call with JSON args, gas and deposit", () => {
    const bytes = signedBytes(
      "usdc.test",
      actions.functionCall("ft_transfer_call", { receiver_id: "app.test", amount: "5", msg: "{}" }, 250n * TGAS, 1n),
    );
    const summary = summarizeDelegate(decodeSignedDelegate(bytes));
    expect(summary).toEqual({
      senderId: "a".repeat(64),
      receiverId: "usdc.test",
      calls: [
        {
          methodName: "ft_transfer_call",
          args: { receiver_id: "app.test", amount: "5", msg: "{}" },
          gas: 250n * TGAS,
          deposit: 1n,
        },
      ],
    });
    expect(checkDelegate(summary, { payday: "app.test", usdc: "usdc.test", allowMint: true })).toEqual({ ok: true });
  });

  it("re-encodes to the same bytes, so the relayed signature stays valid", () => {
    const bytes = signedBytes("app.test", actions.functionCall("withdraw", { stream_id: 1 }, 40n * TGAS, 0n));
    expect(encodeSignedDelegate(decodeSignedDelegate(bytes))).toEqual(bytes);
  });

  it("reports non-function-call actions as null", () => {
    const bytes = signedBytes("app.test", actions.transfer(1n));
    expect(summarizeDelegate(decodeSignedDelegate(bytes)).calls).toEqual([null]);
  });
});
