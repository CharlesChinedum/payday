import { isNearAccountId } from "./address";
import { ONE_USDC } from "./config";
import type { DraftRow } from "./csv";
import { formatUsdc, parseUsdc } from "./money";

/**
 * Request-to-be-paid links. A worker fills in what they want and gets a link that opens
 * Run payroll with the stream already filled in. The link carries no authority: the
 * employer still reads it, checks the account and funds it themselves.
 */
export interface PayRequest {
  worker: string;
  /** Base units (6 decimals). */
  amount: bigint;
  days: number;
  note: string;
}

export const MAX_REQUEST_DAYS = 365;
export const MAX_NOTE_LENGTH = 80;
const MAX_REQUEST = 1_000_000n * ONE_USDC;

/** Printable text only, single-spaced, cut to length: it is shown to the payer and on the card. */
export function cleanNote(note: string): string {
  return note
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

type Params = { get(name: string): string | null };

/** The request in a link, or null if anything in it is missing or out of range. */
export function parseRequest(params: Params): PayRequest | null {
  const worker = params.get("pay")?.trim().toLowerCase() ?? "";
  const daysText = params.get("days") ?? "";
  if (!isNearAccountId(worker) || !/^\d{1,3}$/.test(daysText)) return null;
  const days = Number(daysText);
  if (days < 1 || days > MAX_REQUEST_DAYS) return null;
  let amount: bigint;
  try {
    amount = parseUsdc(params.get("amount") ?? "");
  } catch {
    return null;
  }
  if (amount < ONE_USDC || amount > MAX_REQUEST) return null;
  return { worker, amount, days, note: cleanNote(params.get("note") ?? "") };
}

/** "3000" or "12.5": how the form and the link write an amount. */
const plainAmount = (units: bigint) => formatUsdc(units, 6).replaceAll(",", "").replace(/\.?0+$/, "");

function query(r: PayRequest): string {
  const q = new URLSearchParams({ pay: r.worker, amount: plainAmount(r.amount), days: String(r.days) });
  if (r.note) q.set("note", r.note);
  return q.toString();
}

/** The link the worker sends: Run payroll, filled in. */
export const requestPath = (r: PayRequest) => `/employer?${query(r)}`;

/** Its preview card. */
export const requestCardPath = (r: PayRequest) => `/api/og/request?${query(r)}`;

const isoDate = (secs: number) => new Date(secs * 1000).toISOString().slice(0, 10);

/**
 * The payroll row for a request: from 00:00 UTC tomorrow for exactly `days` days. Never
 * backdated, so nothing is withdrawable the moment it is funded, and the dates in the form
 * are whole days.
 */
export function requestDraft(r: PayRequest, nowSecs: number): DraftRow {
  const tomorrow = (Math.floor(nowSecs / 86_400) + 1) * 86_400;
  return { worker: r.worker, amount: plainAmount(r.amount), start: isoDate(tomorrow), end: isoDate(tomorrow + r.days * 86_400) };
}

export const daysText = (days: number) => (days === 1 ? "1 day" : `${days} days`);

/** "3,000" for whole amounts, "450.50" otherwise. */
export const requestAmount = (units: bigint) => formatUsdc(units).replace(/\.00$/, "");

/** "3,000 USDC over 30 days". */
export const requestSummary = (r: PayRequest) => `${requestAmount(r.amount)} USDC over ${daysText(r.days)}`;
