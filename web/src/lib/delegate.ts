import { deserialize } from "borsh";
import { SCHEMA, type SignedDelegate } from "near-api-js";
import type { DelegateSummary } from "./policy";

/**
 * Borsh-decodes a signed delegate action produced by `encodeSignedDelegate`. near-api-js
 * 7.4 has no decoder; `relayMetaTransaction` re-serializes the result by schema.
 */
export function decodeSignedDelegate(bytes: Uint8Array): SignedDelegate {
  return deserialize(SCHEMA.SignedDelegate, bytes) as SignedDelegate;
}

/** borsh decodes `Vec<u8>` as a plain number array, so normalise before decoding text. */
function decodeArgs(bytes: ArrayLike<number>): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
  } catch {
    return null;
  }
}

export function summarizeDelegate(signed: SignedDelegate): DelegateSummary {
  const { senderId, receiverId, actions } = signed.delegateAction;
  return {
    senderId,
    receiverId,
    calls: actions.map((a) =>
      a.functionCall
        ? {
            methodName: a.functionCall.methodName,
            args: decodeArgs(a.functionCall.args),
            gas: BigInt(a.functionCall.gas),
            deposit: BigInt(a.functionCall.deposit),
          }
        : null,
    ),
  };
}
