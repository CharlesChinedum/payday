import { describe, expect, it } from "vitest";
import { cleanNote, parseRequest, requestCardPath, requestDraft, requestPath, requestSummary } from "./request";

const from = (query: string) => parseRequest(new URLSearchParams(query));
const NOV_12_15H = Date.UTC(2026, 10, 12, 15) / 1000;

describe("request links", () => {
  it("round-trip through the link", () => {
    const r = { worker: "bob.testnet", amount: 3_000_000_000n, days: 30, note: "Design work, November" };
    expect(requestPath(r)).toBe("/employer?pay=bob.testnet&amount=3000&days=30&note=Design+work%2C+November");
    expect(requestCardPath(r)).toBe("/api/og/request?pay=bob.testnet&amount=3000&days=30&note=Design+work%2C+November");
    expect(from(requestPath(r).split("?")[1])).toEqual(r);
    expect(from("pay=Bob.Testnet&amount=12.5&days=7")).toEqual({ worker: "bob.testnet", amount: 12_500_000n, days: 7, note: "" });
  });

  it("refuse anything missing or out of range", () => {
    for (const bad of [
      "",
      "pay=bob.testnet&amount=3000",
      "pay=bob!.testnet&amount=3000&days=30",
      "pay=bob.testnet&amount=0.5&days=30",
      "pay=bob.testnet&amount=1,000&days=30",
      "pay=bob.testnet&amount=1000001&days=30",
      "pay=bob.testnet&amount=3000&days=0",
      "pay=bob.testnet&amount=3000&days=366",
      "pay=bob.testnet&amount=3000&days=1.5",
    ]) {
      expect(from(bad), bad).toBeNull();
    }
  });

  it("keep notes to one short printable line", () => {
    expect(cleanNote("  line one\nline‮two\u0000 ")).toBe("line one line two");
    expect(cleanNote("x".repeat(200))).toHaveLength(80);
  });

  it("fill a payroll row for whole days from today, UTC", () => {
    const r = { worker: "bob.testnet", amount: 3_000_000_000n, days: 30, note: "" };
    expect(requestDraft(r, NOV_12_15H)).toEqual({ worker: "bob.testnet", amount: "3000", start: "2026-11-12", end: "2026-12-12" });
    expect(requestSummary(r)).toBe("3,000 USDC over 30 days");
    expect(requestSummary({ ...r, days: 1 })).toBe("3,000 USDC over 1 day");
    expect(requestSummary({ ...r, amount: 450_500_000n })).toBe("450.50 USDC over 30 days");
  });
});
