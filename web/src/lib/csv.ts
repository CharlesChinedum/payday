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

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const DAY = 86_400;

function parseDate(value: string, field: string, line: number): number {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new Error(`Line ${line}: ${field} "${value}" is not a date (use YYYY-MM-DD)`);
  return Math.floor(ms / 1000);
}

/**
 * Parses `worker,amount,start,end`. A header row is optional. `start` defaults to now and
 * `end` to 30 days after start; dates are YYYY-MM-DD (UTC) or full ISO timestamps.
 */
export function parsePayrollCsv(text: string, nowSecs: number): PayrollRow[] {
  const rows: PayrollRow[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const cells = raw.split(",").map((c) => c.trim());
    if (cells.every((c) => c === "")) return;
    if (i === 0 && isHeader(cells)) return;

    const [worker, amount, startCell = "", endCell = ""] = cells;
    if (!worker || !ACCOUNT_ID.test(worker) || worker.length < 2 || worker.length > 64) {
      throw new Error(`Line ${line}: "${worker}" is not a NEAR account`);
    }
    let units: bigint;
    try {
      units = parseUsdc(amount ?? "");
    } catch {
      throw new Error(`Line ${line}: "${amount ?? ""}" is not a USDC amount`);
    }
    if (units < 1_000_000n) throw new Error(`Line ${line}: each stream must be at least 1 USDC`);

    const start = startCell ? parseDate(startCell, "start", line) : nowSecs;
    const stop = endCell ? parseDate(endCell, "end", line) : start + 30 * DAY;
    if (stop <= start) throw new Error(`Line ${line}: end must be after start`);
    if (stop <= nowSecs) throw new Error(`Line ${line}: end must be in the future`);
    rows.push({ worker, amount: units, start, stop });
  });
  if (rows.length === 0) throw new Error("Add at least one worker");
  if (rows.length > 25) throw new Error("At most 25 workers per funding transfer");
  return rows;
}

/** One editable line of the payroll form; every field is the text the user typed. */
export interface DraftRow {
  worker: string;
  amount: string;
  start: string;
  end: string;
}

export const EMPTY_DRAFT_ROW: DraftRow = { worker: "", amount: "", start: "", end: "" };

const isHeader = (cells: string[]) => cells[0]?.toLowerCase() === "worker";

/** Splits CSV text into editable rows without validating them; `parsePayrollCsv` does that. */
export function csvToDraftRows(text: string): DraftRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((c) => c.trim()))
    .filter((cells, i) => cells.some((c) => c !== "") && !(i === 0 && isHeader(cells)))
    .map(([worker = "", amount = "", start = "", end = ""]) => ({ worker, amount, start, end }));
}

/** Blank rows are dropped, so a half-filled form validates only what was entered. */
export function draftRowsToCsv(rows: DraftRow[]): string {
  return rows
    .filter((r) => r.worker.trim() !== "" || r.amount.trim() !== "")
    .map((r) => [r.worker, r.amount, r.start, r.end].map((c) => c.trim()).join(","))
    .join("\n");
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
