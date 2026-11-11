import { isNearAccountId } from "./address";
import { ONE_USDC } from "./config";
import { formatUsdc, parseUsdc, usdcDecimal } from "./money";

export interface PayrollRow {
  worker: string;
  amount: bigint;
  start: number;
  stop: number;
}

export interface StreamRecord {
  id: number;
  employer: string;
  worker: string;
  deposit: string;
  withdrawn: string;
  withdrawable: string;
  start: number;
  stop: number;
}

const DAY = 86_400;
const MAX_ROWS = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const COLUMNS = ["worker", "amount", "start", "end"] as const;

/** One payroll line as typed: in the form, or one CSV row. */
export interface DraftRow {
  worker: string;
  amount: string;
  start: string;
  end: string;
}

export const EMPTY_DRAFT_ROW: DraftRow = { worker: "", amount: "", start: "", end: "" };

/** YYYY-MM-DD (midnight UTC) or a full ISO-8601 time ending in Z; nothing else. */
function parseDate(value: string, field: string, label: string): number {
  const isDate = DATE.test(value);
  if (!isDate && !ISO_UTC.test(value)) {
    throw new Error(`${label}: ${field} "${value}" must be a date like 2026-12-01`);
  }
  const ms = Date.parse(isDate ? `${value}T00:00:00Z` : value);
  // Date.parse rolls 2026-02-30 over to March; a date that does not round-trip is not real.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error(`${label}: ${field} "${value}" is not a real date`);
  }
  return Math.floor(ms / 1000);
}

/** Validates one payroll line. `start` defaults to now and `end` to 30 days after start. */
export function parsePayrollRow(row: DraftRow, label: string, nowSecs: number): PayrollRow {
  const worker = row.worker.trim();
  if (!isNearAccountId(worker)) throw new Error(`${label}: "${worker}" is not a NEAR account`);
  let amount: bigint;
  try {
    amount = parseUsdc(row.amount);
  } catch {
    throw new Error(`${label}: "${row.amount.trim()}" is not a USDC amount (write 1000 or 12.50, without commas)`);
  }
  if (amount < ONE_USDC) throw new Error(`${label}: each stream must be at least 1 USDC`);

  const startText = row.start.trim();
  const endText = row.end.trim();
  const start = startText ? parseDate(startText, "start", label) : nowSecs;
  const stop = endText ? parseDate(endText, "end", label) : start + 30 * DAY;
  if (stop <= start) throw new Error(`${label}: end must be after start`);
  if (stop <= nowSecs) throw new Error(`${label}: end must be in the future`);
  return { worker, amount, start, stop };
}

const isBlank = (r: DraftRow) => COLUMNS.every((c) => r[c].trim() === "");

/** Validates the form's rows, ignoring fully blank ones. */
export function parseDraftRows(rows: DraftRow[], nowSecs: number): PayrollRow[] {
  const parsed = rows.flatMap((r, i) => (isBlank(r) ? [] : [parsePayrollRow(r, `Row ${i + 1}`, nowSecs)]));
  if (parsed.length === 0) throw new Error("Add at least one worker");
  if (parsed.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} workers per funding transfer`);
  return parsed;
}

const isHeader = (cells: string[]) => cells[0]?.toLowerCase() === "worker";

/**
 * Splits `worker,amount,start,end` CSV into rows. A header row is optional. A row with
 * extra columns is refused: it almost always means an amount was written as 1,000.
 */
export function csvToDraftRows(text: string): DraftRow[] {
  const rows: DraftRow[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.every((c) => c === "") || (i === 0 && isHeader(cells))) return;
    if (cells.length > COLUMNS.length) {
      throw new Error(`Line ${i + 1} has ${cells.length} columns, not 4. Write amounts without commas (1000, not 1,000).`);
    }
    const [worker = "", amount = "", start = "", end = ""] = cells;
    rows.push({ worker, amount, start, end });
  });
  return rows;
}

export function parsePayrollCsv(text: string, nowSecs: number): PayrollRow[] {
  return parseDraftRows(csvToDraftRows(text), nowSecs);
}

export function fundingMsg(rows: PayrollRow[]): string {
  return JSON.stringify({
    streams: rows.map((r) => ({ worker: r.worker, amount: r.amount.toString(), start: r.start, stop: r.stop })),
  });
}

const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(".000Z", "Z");

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One row per stream, amounts in plain USDC decimals, times in UTC. */
export function streamsCsv(streams: StreamRecord[], exportedAt: Date): string {
  const header = [
    "stream_id",
    "employer",
    "worker",
    "currency",
    "total_amount",
    "paid_out",
    "earned_not_paid",
    "not_yet_earned",
    "start_utc",
    "end_utc",
    "status_at_export",
  ];
  const now = exportedAt.getTime() / 1000;
  const rows = streams.map((s) => {
    const deposit = BigInt(s.deposit);
    const withdrawn = BigInt(s.withdrawn);
    const earnedNotPaid = BigInt(s.withdrawable);
    const notYet = deposit - withdrawn - earnedNotPaid;
    const status = now < s.start ? "scheduled" : now < s.stop ? "streaming" : "finished";
    return [
      String(s.id),
      s.employer,
      s.worker,
      "USDC",
      usdcDecimal(deposit),
      usdcDecimal(withdrawn),
      usdcDecimal(earnedNotPaid),
      usdcDecimal(notYet),
      iso(s.start),
      iso(s.stop),
      status,
    ];
  });
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
}

export function summarizeRows(rows: PayrollRow[]): string {
  const total = rows.reduce((sum, r) => sum + r.amount, 0n);
  return `${rows.length} worker${rows.length === 1 ? "" : "s"}, ${formatUsdc(total)} USDC`;
}
