import { describe, expect, it } from "vitest";
import type { StreamRecord } from "./csv";
import { monthPeriod, payslipLines, recentMonths } from "./payslip";
import { CURRENCIES, formatLocal, guessCurrency, parseRates, toLocal } from "./rates";

const NOV_1 = Date.UTC(2026, 10, 1) / 1000;
const DEC_1 = Date.UTC(2026, 11, 1) / 1000;
const NOV_12 = Date.UTC(2026, 10, 12) / 1000;

const stream = (over: Partial<StreamRecord>): StreamRecord => ({
  id: 1,
  employer: "acme.testnet",
  worker: "ada.testnet",
  deposit: "3000000000",
  withdrawn: "0",
  withdrawable: "0",
  start: NOV_1,
  stop: NOV_1 + 30 * 86_400,
  ...over,
});

describe("payslip periods", () => {
  it("cover a whole past month in UTC", () => {
    expect(monthPeriod("2026-10", NOV_12)).toMatchObject({ from: Date.UTC(2026, 9, 1) / 1000, to: NOV_1, toDate: false, label: "October 2026" });
  });

  it("stop at now for the running month and refuse the future or junk", () => {
    expect(monthPeriod("2026-11", NOV_12)).toMatchObject({ from: NOV_1, to: NOV_12, toDate: true });
    expect(monthPeriod("2026-12", NOV_12)).toBeNull();
    for (const bad of ["2026-13", "2026-1", "26-11", "2026-11-01", ""]) expect(monthPeriod(bad, NOV_12)).toBeNull();
  });

  it("offer months back to the first stream, newest first, capped", () => {
    expect(recentMonths(NOV_12, Date.UTC(2026, 8, 20) / 1000)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(recentMonths(NOV_12, null)).toEqual(["2026-11"]);
    expect(recentMonths(NOV_12, 0, 3)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(recentMonths(Date.UTC(2027, 0, 5) / 1000, Date.UTC(2026, 10, 3) / 1000)).toEqual(["2027-01", "2026-12", "2026-11"]);
  });
});

describe("payslip lines", () => {
  it("count only what vested inside the period, by the contract's rule", () => {
    // 3,000 USDC over 30 days from 1 Nov: 11 days to 12 Nov is 1,100 USDC.
    const [line] = payslipLines([stream({})], "ada.testnet", monthPeriod("2026-11", NOV_12)!);
    expect(line.earned).toBe(1_100_000_000n);
    expect(line.perDay).toBe(100_000_000n);
  });

  it("split a stream across months and skip other workers and idle streams", () => {
    const across = stream({ start: NOV_1 + 15 * 86_400, stop: NOV_1 + 45 * 86_400 });
    const nov = payslipLines([across], "ada.testnet", monthPeriod("2026-11", DEC_1 + 20 * 86_400)!);
    const dec = payslipLines([across], "ada.testnet", monthPeriod("2026-12", DEC_1 + 20 * 86_400)!);
    expect(nov[0].earned + dec[0].earned).toBe(3_000_000_000n);
    expect(nov[0].earned).toBe(1_500_000_000n);
    expect(payslipLines([stream({ worker: "bo.testnet" })], "ada.testnet", monthPeriod("2026-11", NOV_12)!)).toEqual([]);
    expect(payslipLines([stream({ start: DEC_1, stop: DEC_1 + 86_400 })], "ada.testnet", monthPeriod("2026-11", NOV_12)!)).toEqual([]);
  });
});

describe("local currency", () => {
  const upstream = {
    result: "success",
    base_code: "USD",
    time_last_update_unix: 1_794_441_751,
    rates: Object.fromEntries(CURRENCIES.map((c, i) => [c.code, 10 + i])),
  };

  it("keeps only offered currencies with sane rates", () => {
    const rates = parseRates({ ...upstream, rates: { ...upstream.rates, NGN: 1349.8, XYZ: 5, KES: -1, GHS: "11", ZAR: Infinity } });
    expect(rates.perUsd.NGN).toBe(1349.8);
    expect(rates.perUsd).not.toHaveProperty("XYZ");
    expect(rates.perUsd).not.toHaveProperty("KES");
    expect(rates.perUsd).not.toHaveProperty("GHS");
    expect(rates.perUsd).not.toHaveProperty("ZAR");
    expect(rates.updated).toBe(1_794_441_751);
  });

  it("rejects answers that are not what was asked", () => {
    expect(() => parseRates({ ...upstream, result: "error" })).toThrow();
    expect(() => parseRates({ ...upstream, base_code: "EUR" })).toThrow();
    expect(() => parseRates({ ...upstream, rates: { NGN: 1 } })).toThrow("too few");
    expect(() => parseRates(null)).toThrow();
  });

  it("guesses from the browser's languages and converts USDC units", () => {
    expect(guessCurrency(["en-NG", "en"])).toBe("NGN");
    expect(guessCurrency(["en", "sw-KE"])).toBe("KES");
    expect(guessCurrency(["en-US", "en"])).toBeNull();
    expect(guessCurrency(["zh-Hant-TW"])).toBeNull();
    expect(toLocal(2_500_000n, 1349.8)).toBeCloseTo(3374.5);
    expect(formatLocal(3374.5, "NGN", "en-NG")).toBe("₦3,375");
    expect(formatLocal(12.345, "KES", "en-KE")).toMatch(/12\.35/);
  });
});
