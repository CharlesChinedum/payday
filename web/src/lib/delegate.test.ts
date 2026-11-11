import { describe, expect, it } from "vitest";
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  Signature,
  actions,
  buildDelegateAction,
  encodeSignedDelegate,
  type KeyPairString,
  type SignedDelegate,
} from "near-api-js";
import { decodeSignedDelegate, summarizeDelegate, verifyDelegateSignature } from "./delegate";
import { checkDelegate } from "./policy";
import { TGAS } from "./config";

const ctx = { payday: "app.test", usdc: "usdc.test" };
const implicitId = (key: KeyPair) => Buffer.from(key.getPublicKey().ed25519Key!.data).toString("hex");

/** Signs like the browser does, without touching a network. */
async function signed(key: KeyPair, receiverId: string, action: ReturnType<typeof actions.functionCall>, senderId = implicitId(key)) {
  const delegateAction = buildDelegateAction({
    senderId,
    receiverId,
    actions: [action],
    nonce: 7n,
    maxBlockHeight: 1000n,
    publicKey: key.getPublicKey(),
  });
  const account = new Account(senderId, new JsonRpcProvider({ url: "http://127.0.0.1:1" }), key.toString() as KeyPairString);
  const { signedDelegate } = await account.getSigner()!.signDelegateAction(delegateAction);
  return encodeSignedDelegate(signedDelegate);
}

function forged(key: KeyPair, receiverId: string, action: ReturnType<typeof actions.functionCall>) {
  const delegateAction = buildDelegateAction({
    senderId: implicitId(key),
    receiverId,
    actions: [action],
    nonce: 7n,
    maxBlockHeight: 1000n,
    publicKey: key.getPublicKey(),
  });
  const wrapped = actions.signedDelegate({ delegateAction, signature: new Signature({ keyType: 0, data: new Uint8Array(64) }) });
  return encodeSignedDelegate(wrapped.signedDelegate!);
}

describe("signed delegate decoding", () => {
  it("round-trips a function call with JSON args, gas, deposit and key", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const bytes = await signed(
      key,
      "usdc.test",
      actions.functionCall("ft_transfer_call", { receiver_id: "app.test", amount: "2000000", msg: '{"send_to":"bob.test"}' }, 150n * TGAS, 1n),
    );
    const summary = summarizeDelegate(decodeSignedDelegate(bytes));
    expect(summary).toMatchObject({
      senderId: implicitId(key),
      receiverId: "usdc.test",
      publicKey: key.getPublicKey().toString(),
      nonce: 7n,
      maxBlockHeight: 1000n,
      calls: [{ methodName: "ft_transfer_call", gas: 150n * TGAS, deposit: 1n }],
    });
    expect(checkDelegate(summary, ctx)).toMatchObject({ ok: true, call: { kind: "send" } });
  });

  it("re-encodes to the same bytes, so the relayed signature stays valid", async () => {
    const bytes = await signed(KeyPair.fromRandom("ed25519"), "app.test", actions.functionCall("withdraw", { stream_id: 1 }, 100n * TGAS, 0n));
    expect(encodeSignedDelegate(decodeSignedDelegate(bytes))).toEqual(bytes);
  });

  it("reports non-function-call actions as null", () => {
    const key = KeyPair.fromRandom("ed25519");
    const delegateAction = buildDelegateAction({
      senderId: implicitId(key),
      receiverId: "app.test",
      actions: [actions.transfer(1n)],
      nonce: 1n,
      maxBlockHeight: 1n,
      publicKey: key.getPublicKey(),
    });
    const wrapped = actions.signedDelegate({ delegateAction, signature: new Signature({ keyType: 0, data: new Uint8Array(64) }) });
    expect(summarizeDelegate(decodeSignedDelegate(encodeSignedDelegate(wrapped.signedDelegate!))).calls).toEqual([null]);
  });
});

describe("signature verification (H-01)", () => {
  const withdraw = actions.functionCall("withdraw", { stream_id: 1 }, 100n * TGAS, 0n);

  it("accepts a delegate signed by the sender's own key", async () => {
    const bytes = await signed(KeyPair.fromRandom("ed25519"), "app.test", withdraw);
    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toEqual({ ok: true });
  });

  it("rejects the forged request from the audit: an all-zero signature", () => {
    const bytes = forged(KeyPair.fromRandom("ed25519"), "app.test", withdraw);
    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toEqual({ ok: false, reason: "Invalid signature" });
  });

  it("rejects a sender that is not the signing key's implicit account", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const bytes = await signed(key, "app.test", withdraw, "victim.test");
    expect(verifyDelegateSignature(decodeSignedDelegate(bytes))).toMatchObject({ ok: false, reason: expect.stringContaining("implicit account") });
  });

  it("rejects a delegate altered after signing", async () => {
    const bytes = await signed(KeyPair.fromRandom("ed25519"), "app.test", withdraw);
    const tampered: SignedDelegate = decodeSignedDelegate(bytes);
    tampered.delegateAction.receiverId = "usdc.test";
    expect(verifyDelegateSignature(tampered)).toEqual({ ok: false, reason: "Invalid signature" });
  });
});
