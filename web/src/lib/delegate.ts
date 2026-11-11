import { createHash } from "node:crypto";
import { deserialize } from "borsh";
import { KeyType, PublicKey, SCHEMA, encodeDelegateAction, type SignedDelegate } from "near-api-js";
import type { DelegateSummary } from "./policy";

/** Largest JSON argument blob a sponsored call may carry. */
export const MAX_ARGS_BYTES = 8 * 1024;

/**
 * Borsh-decodes a signed delegate action produced by `encodeSignedDelegate`. near-api-js
 * 7.4 has no decoder; `relayMetaTransaction` re-serializes the result by schema.
 */
export function decodeSignedDelegate(bytes: Uint8Array): SignedDelegate {
  return deserialize(SCHEMA.SignedDelegate, bytes) as SignedDelegate;
}

/** borsh decodes `Vec<u8>` and fixed arrays as plain number arrays. */
const bytesOf = (value: ArrayLike<number>) => Uint8Array.from(value);

function decodeArgs(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_ARGS_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** The ed25519 key that signed the delegate, as 32 raw bytes, or null for other key types. */
function ed25519KeyOf(signed: SignedDelegate): Uint8Array | null {
  const key = signed.delegateAction.publicKey as { ed25519Key?: { data: ArrayLike<number> } };
  return key.ed25519Key ? bytesOf(key.ed25519Key.data) : null;
}

export function summarizeDelegate(signed: SignedDelegate): DelegateSummary {
  const { senderId, receiverId, actions, nonce, maxBlockHeight } = signed.delegateAction;
  const key = ed25519KeyOf(signed);
  return {
    senderId,
    receiverId,
    publicKey: key ? new PublicKey({ keyType: KeyType.ED25519, data: key }).toString() : null,
    nonce: BigInt(nonce),
    maxBlockHeight: BigInt(maxBlockHeight),
    calls: actions.map((a) =>
      a.functionCall
        ? {
            methodName: a.functionCall.methodName,
            args: decodeArgs(bytesOf(a.functionCall.args)),
            gas: BigInt(a.functionCall.gas),
            deposit: BigInt(a.functionCall.deposit),
          }
        : null,
    ),
  };
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Checks what the chain would only check after the relayer has paid: the sender is the
 * implicit account of the signing key, and the signature covers this exact delegate
 * (NEP-366 signs the SHA-256 of the prefixed, borsh-encoded delegate action).
 */
export function verifyDelegateSignature(signed: SignedDelegate): SignatureCheck {
  const key = ed25519KeyOf(signed);
  if (!key) return { ok: false, reason: "Only ed25519 keys are sponsored" };
  const senderId = signed.delegateAction.senderId;
  if (senderId !== Buffer.from(key).toString("hex")) {
    return { ok: false, reason: "The sender must be the implicit account of the signing key" };
  }
  const signature = signed.signature as { ed25519Signature?: { data: ArrayLike<number> } };
  if (!signature.ed25519Signature) return { ok: false, reason: "Only ed25519 signatures are sponsored" };

  const hash = createHash("sha256").update(encodeDelegateAction(signed.delegateAction)).digest();
  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: key });
  const valid = publicKey.verify(new Uint8Array(hash), bytesOf(signature.ed25519Signature.data));
  return valid ? { ok: true } : { ok: false, reason: "Invalid signature" };
}
