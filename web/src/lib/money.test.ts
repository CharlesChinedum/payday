import { describe, expect, it } from "vitest";
import { formatUsdc, parseUsdc, usdcDecimal, vestedAt, vestedSmooth } from "./money";
import { fundingMsg, parsePayrollCsv, streamsCsv } from "./csv";

describe("USDC amounts", () => {
  it("parses decimals exactly", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("1,234.5")).toBe(1_234_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
  });

  it("rejects bad input", () => {
    for (const bad of ["", "abc", "1.0000001", "-1", "1e6"]) expect(() => parseUsdc(bad)).toThrow();
  });

  it("formats for people and for accountants", () => {
    expect(formatUsdc(1_234_500_000n)).toBe("1,234.50");
    expect(formatUsdc(1_401_987n, 6)).toBe("1.401987");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(usdcDecimal(1_401_987n)).toBe("1.401987");
    expect(usdcDecimal(5n)).toBe("0.000005");
  });
});

describe("vesting matches the contract", () => {
  it("is linear, rounds down and caps", () => {
    expect(vestedAt(1000n, 100, 200, 50)).toBe(0n);
    expect(vestedAt(1000n, 100, 200, 150)).toBe(500n);
    expect(vestedAt(1000n, 100, 200, 133)).toBe(330n);
    expect(vestedAt(1000n, 100, 200, 999)).toBe(1000n);
  });

  it("smooth vesting never runs ahead of the deposit", () => {
    expect(vestedSmooth(1000n, 100, 200, 150_500)).toBe(505n);
    expect(vestedSmooth(1000n, 100, 200, 300_000)).toBe(1000n);
  });
});

describe("payroll CSV", () => {
  const NOW = Date.parse("2026-11-12T00:00:00Z") / 1000;

  it("parses rows with and without dates and a header", () => {
    const rows = parsePayrollCsv(
      "worker,amount,start,end\nalice.testnet,1000,2026-11-01,2026-11-30\nbob.testnet,250.5\n\n",
      NOW,
    );
    expect(rows).toEqual([
      {
        worker: "alice.testnet",
        amount: 1_000_000_000n,
        start: Date.parse("2026-11-01T00:00:00Z") / 1000,
        stop: Date.parse("2026-11-30T00:00:00Z") / 1000,
      },
      { worker: "bob.testnet", amount: 250_500_000n, start: NOW, stop: NOW + 30 * 86_400 },
    ]);
    expect(JSON.parse(fundingMsg(rows)).streams[1]).toEqual({
      worker: "bob.testnet",
      amount: "250500000",
      start: NOW,
      stop: NOW + 30 * 86_400,
    });
  });

  it("accepts 64-hex implicit accounts", () => {
    expect(parsePayrollCsv(`${"ab".repeat(32)},5`, NOW)).toHaveLength(1);
  });

  it("explains what is wrong and on which line", () => {
    expect(() => parsePayrollCsv("Alice!,10", NOW)).toThrow("Line 1");
    expect(() => parsePayrollCsv("alice.testnet,0.5", NOW)).toThrow("at least 1 USDC");
    expect(() => parsePayrollCsv("alice.testnet,10,2026-12-01,2026-11-01", NOW)).toThrow("end must be after start");
    expect(() => parsePayrollCsv("alice.testnet,10,2026-01-01,2026-02-01", NOW)).toThrow("in the future");
    expect(() => parsePayrollCsv("", NOW)).toThrow("at least one worker");
  });
});

describe("accountant CSV", () => {
  it("splits each stream into paid, earned and not yet earned", () => {
    const csv = streamsCsv(
      [
        {
          id: 1,
          employer: "acme.testnet",
          worker: "alice.testnet",
          deposit: "1000000000",
          withdrawn: "1401987",
          withdrawable: "234628",
          start: 1_794_378_620,
          stop: 1_796_974_220,
        },
      ],
      new Date("2026-11-12T00:00:00Z"),
    );
    const [header, row] = csv.trim().split("\n");
    expect(header.split(",")).toContain("earned_not_paid");
    expect(row).toBe(
      "1,acme.testnet,alice.testnet,USDC,1000.000000,1.401987,0.234628,998.363385,2026-11-11T06:30:20Z,2026-12-11T07:30:20Z,streaming",
    );
  });
});
