import { describe, expect, it } from "vitest";
import { formatUsdc, parseUsdc, splitUsdc, usdcDecimal, vestedAt, vestedSmooth } from "./money";
import { csvToDraftRows, fundingMsg, parseDraftRows, parsePayrollCsv, streamsCsv } from "./csv";

describe("USDC amounts", () => {
  it("parses decimals exactly", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc(" 1234.5 ")).toBe(1_234_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
  });

  it("rejects bad input", () => {
    for (const bad of ["", "abc", "1.0000001", "-1", "1e6", "1.", ".5"]) expect(() => parseUsdc(bad)).toThrow();
  });

  it("refuses commas instead of guessing what they mean (L-02)", () => {
    expect(() => parseUsdc("1,000")).toThrow("without commas");
    expect(() => parseUsdc("12,50")).toThrow("without commas");
  });

  it("formats for people and for accountants", () => {
    expect(formatUsdc(1_234_500_000n)).toBe("1,234.50");
    expect(formatUsdc(1_401_987n, 6)).toBe("1.401987");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(usdcDecimal(1_401_987n)).toBe("1.401987");
    expect(usdcDecimal(5n)).toBe("0.000005");
  });

  it("splits into money and a sub-cent tail", () => {
    expect(splitUsdc(1_234_567_890n)).toEqual(["1,234.56", "7890"]);
    expect(splitUsdc(5n)).toEqual(["0.00", "0005"]);
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

  it("explains what is wrong and on which row", () => {
    expect(() => parsePayrollCsv("Alice!,10", NOW)).toThrow("Row 1");
    expect(() => parsePayrollCsv("alice.testnet,0.5", NOW)).toThrow("at least 1 USDC");
    expect(() => parsePayrollCsv("alice.testnet,10,2026-12-01,2026-11-01", NOW)).toThrow("end must be after start");
    expect(() => parsePayrollCsv("alice.testnet,10,2026-01-01,2026-02-01", NOW)).toThrow("in the future");
    expect(() => parsePayrollCsv("", NOW)).toThrow("at least one worker");
  });

  it("refuses an amount written with a thousands separator instead of shifting columns (L-02)", () => {
    expect(() => parsePayrollCsv("alice.testnet,1,000,2026-11-12,2026-12-01", NOW)).toThrow("without commas");
  });

  it("accepts only real dates in YYYY-MM-DD or ISO-8601 UTC (L-02)", () => {
    expect(() => parsePayrollCsv("alice.testnet,10,000,2026-12-01", NOW)).toThrow("must be a date");
    expect(() => parsePayrollCsv("alice.testnet,10,12/01/2026,2026-12-31", NOW)).toThrow("must be a date");
    expect(() => parsePayrollCsv("alice.testnet,10,2026-11-12,2026-02-30", NOW)).toThrow("not a real date");
    expect(parsePayrollCsv("alice.testnet,10,2026-11-12T08:30:00Z,2026-12-01", NOW)[0].start).toBe(
      Date.parse("2026-11-12T08:30:00Z") / 1000,
    );
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

describe("payroll form rows", () => {
  const NOW = Date.parse("2026-11-12T00:00:00Z") / 1000;

  it("imports CSV into editable rows", () => {
    expect(csvToDraftRows("worker,amount,start,end\nalice.testnet, 1000 ,2026-11-01,\n\nbob.testnet,250.5\n")).toEqual([
      { worker: "alice.testnet", amount: "1000", start: "2026-11-01", end: "" },
      { worker: "bob.testnet", amount: "250.5", start: "", end: "" },
    ]);
  });

  it("validates each field directly, ignoring fully blank rows", () => {
    const rows = parseDraftRows(
      [
        { worker: "", amount: "", start: "", end: "" },
        { worker: "alice.testnet", amount: "1000", start: "", end: "" },
      ],
      NOW,
    );
    expect(rows).toEqual([{ worker: "alice.testnet", amount: 1_000_000_000n, start: NOW, stop: NOW + 30 * 86_400 }]);
    expect(() =>
      parseDraftRows([{ worker: "alice.testnet", amount: "1,000", start: "2026-11-12", end: "" }], NOW),
    ).toThrow("Row 1");
  });
});

