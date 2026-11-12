import type { StreamRecord } from "./csv";
import { formatUsdc, vestedAt } from "./money";

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

/** Query value that keeps the amount out of the link preview. */
export const HIDE_AMOUNT = "hide";

/** The payslip's own link; `hideAmount` only changes the preview card, not the page. */
export function payslipPath(worker: string, month: string, hideAmount = false): string {
  const query = new URLSearchParams({ worker, month });
  if (hideAmount) query.set("amount", HIDE_AMOUNT);
  return `/payslip?${query}`;
}

/** The same query, for the preview image. */
export const payslipCardPath = (worker: string, month: string, hideAmount = false) =>
  payslipPath(worker, month, hideAmount).replace("/payslip?", "/api/og/payslip?");

export interface ShareCard {
  title: string;
  /** "1,010.99 USDC", or null when the amount is hidden or nothing was earned. */
  amount: string | null;
  caption: string;
}

/** What a shared payslip link shows in its preview. */
export function shareCard(lines: PayslipLine[], period: Period, hideAmount: boolean): ShareCard {
  const title = period.toDate ? `${period.label}, so far` : period.label;
  if (lines.length === 0) return { title, amount: null, caption: "No Payday salary earned in this month" };
  const employers = new Set(lines.map((l) => l.stream.employer)).size;
  const from = employers === 1 ? "one employer" : `${employers} employers`;
  if (hideAmount) return { title, amount: null, caption: `Paid by the second from ${from}` };
  const earned = lines.reduce((sum, l) => sum + l.earned, 0n);
  return { title, amount: `${formatUsdc(earned)} USDC`, caption: `Earned${period.toDate ? " so far" : ""} from ${from}, paid by the second` };
}

/** The text that goes with the link when it is posted. */
export const shareText = (period: Period) =>
  `My Payday payslip for ${period.label}: salary streamed by the second, every figure verifiable on NEAR.`;
