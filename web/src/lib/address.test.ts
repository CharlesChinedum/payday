import { describe, expect, it } from "vitest";
import { checkAddress, isNearAccountId } from "./address";

describe("cash-out address checks", () => {
  it("accepts EIP-55 checksummed and single-case EVM addresses", () => {
    expect(checkAddress("evm", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").ok).toBe(true);
    expect(checkAddress("evm", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").ok).toBe(true);
    expect(checkAddress("evm", "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED").ok).toBe(true);
  });

  it("rejects an EVM address whose mixed case breaks the checksum", () => {
    expect(checkAddress("evm", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toMatchObject({ ok: false });
    expect(checkAddress("evm", "0x123")).toMatchObject({ ok: false });
  });

  it("checks Solana addresses decode to 32 bytes", () => {
    expect(checkAddress("solana", "11111111111111111111111111111111").ok).toBe(true);
    expect(checkAddress("solana", "So11111111111111111111111111111111111111112").ok).toBe(true);
    expect(checkAddress("solana", "0OIl")).toMatchObject({ ok: false });
  });

  it("checks Tron Base58Check", () => {
    expect(checkAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").ok).toBe(true);
    expect(checkAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toMatchObject({ ok: false });
  });

  it("knows NEAR account ids", () => {
    expect(isNearAccountId("alice.testnet")).toBe(true);
    expect(isNearAccountId("a".repeat(64))).toBe(true);
    expect(isNearAccountId("Alice!")).toBe(false);
    expect(isNearAccountId("a".repeat(65))).toBe(false);
  });
});
