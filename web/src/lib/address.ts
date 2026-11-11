import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { CashOutAsset } from "./config";

export type AddressCheck = { ok: true; address: string } | { ok: false; reason: string };

const HINTS: Record<CashOutAsset["kind"], string> = {
  evm: "a 0x… address",
  solana: "a Solana address",
  tron: "a Tron address starting with T",
};

export const addressHint = (kind: CashOutAsset["kind"]) => HINTS[kind];

/** NEAR implicit accounts, which 1Click deposit addresses and Payday accounts are. */
export const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT.test(value);
}

/** Validates a destination address for its chain, including checksums where they exist. */
export function checkAddress(kind: CashOutAsset["kind"], input: string): AddressCheck {
  const address = input.trim();
  const fail = { ok: false as const, reason: `Enter ${HINTS[kind]}` };
  switch (kind) {
    case "evm":
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return fail;
      return isEvmChecksumValid(address)
        ? { ok: true, address }
        : { ok: false, reason: "That address has a typo: its capital letters do not match its checksum" };
    case "solana":
      return decodesTo(address, 32) ? { ok: true, address } : fail;
    case "tron":
      return isTronAddress(address) ? { ok: true, address } : fail;
  }
}

/** EIP-55: all-lowercase or all-uppercase is unchecked; mixed case must match the hash. */
function isEvmChecksumValid(address: string): boolean {
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = keccak_256(new TextEncoder().encode(hex.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const expectUpper = nibble >= 8;
    const ch = hex[i];
    if (/[a-f]/i.test(ch) && (ch === ch.toUpperCase()) !== expectUpper) return false;
  }
  return true;
}

function decodesTo(address: string, length: number): boolean {
  try {
    return base58.decode(address).length === length;
  } catch {
    return false;
  }
}

/** Base58Check: 0x41 prefix, 20-byte body, first 4 bytes of a double SHA-256. */
function isTronAddress(address: string): boolean {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    return false;
  }
  if (bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const check = sha256(sha256(bytes.slice(0, 21)));
  return check.slice(0, 4).every((b, i) => b === bytes[21 + i]);
}
