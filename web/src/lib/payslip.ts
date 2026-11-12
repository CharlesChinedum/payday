import type { StreamRecord } from "./csv";
import { vestedAt } from "./money";

/** A calendar month in UTC, cut off at `now` while it is still running. */
export interface Period {
  month: string;
  from: number;
  to: number;
  /** True for the current month: earnings run to `to`, which is now. */
  toDate: boolean;
  label: string;
}

export interface PayslipLine {
  stream: StreamRecord;
  /** Earned within the period, by the contract's own vesting rule. */
  earned: bigint;
  /** Earned since the stream began, up to the end of the period. */
  earnedToDate: bigint;
  perDay: bigint;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-11" → the month in UTC seconds; null for anything malformed or in the future. */
export function monthPeriod(month: string, nowSecs: number): Period | null {
  const m = MONTH.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const index = Number(m[2]) - 1;
  const from = Date.UTC(year, index, 1) / 1000;
  const end = Date.UTC(year, index + 1, 1) / 1000;
  if (from > nowSecs) return null;
  const label = new Date(from * 1000).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return { month, from, to: Math.min(end, nowSecs), toDate: end > nowSecs, label };
}

export function monthOf(secs: number): string {
  const d = new Date(secs * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Months to offer, newest first: from the earliest stream's start (or this month) back at most `max`. */
export function recentMonths(nowSecs: number, earliestSecs: number | null, max = 12): string[] {
  const months: string[] = [];
  const d = new Date(nowSecs * 1000);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  const stop = monthOf(Math.min(earliestSecs ?? nowSecs, nowSecs));
  while (months.length < max) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    months.push(key);
    if (key <= stop) break;
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return months;
}

/** One line per stream paying `worker` that earned anything in the period. */
export function payslipLines(streams: StreamRecord[], worker: string, period: Period): PayslipLine[] {
  return streams
    .filter((s) => s.worker === worker)
    .map((s) => {
      const deposit = BigInt(s.deposit);
      const before = vestedAt(deposit, s.start, s.stop, period.from);
      const toDate = vestedAt(deposit, s.start, s.stop, period.to);
      const perDay = (deposit * 86_400n) / BigInt(Math.max(1, s.stop - s.start));
      return { stream: s, earned: toDate - before, earnedToDate: toDate, perDay };
    })
    .filter((line) => line.earned > 0n)
    .sort((a, b) => a.stream.id - b.stream.id);
}
