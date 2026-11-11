"use client";

import { useRef, useState, type DragEvent } from "react";
import {
  csvToDraftRows,
  draftRowsToCsv,
  EMPTY_DRAFT_ROW,
  parsePayrollCsv,
  summarizeRows,
  type DraftRow,
  type PayrollRow,
} from "@/lib/csv";
import { formatUsdc } from "@/lib/money";
import { CloseIcon, PlusIcon, UploadIcon } from "../icons";
import { Button, Card, TextInput } from "../ui";

const DEFAULT_AMOUNT = "1000";
const MAX_ROWS = 25;

/** A form row plus a stable identity, so React keeps focus when rows are removed. */
type Draft = DraftRow & { id: number };

type Parsed = { rows: PayrollRow[]; total: bigint } | { error: string };

function parseDrafts(drafts: DraftRow[], nowSecs: number): Parsed {
  try {
    const rows = parsePayrollCsv(draftRowsToCsv(drafts), nowSecs);
    return { rows, total: rows.reduce((sum, r) => sum + r.amount, 0n) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function RowEditor(props: { row: Draft; onChange: (row: Draft) => void; onRemove: () => void; removable: boolean }) {
  const { row, onChange, onRemove, removable } = props;
  const set = (field: keyof DraftRow) => (value: string) => onChange({ ...row, [field]: value });
  return (
    <li className="grid animate-rise grid-cols-6 gap-2 sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_auto]">
      <TextInput
        className="num col-span-6 sm:col-span-1"
        aria-label="Worker account"
        placeholder="worker account"
        spellCheck={false}
        value={row.worker}
        onChange={(e) => set("worker")(e.target.value)}
      />
      <TextInput
        className="num col-span-5 sm:col-span-1"
        aria-label="Amount in USDC"
        placeholder="USDC"
        inputMode="decimal"
        value={row.amount}
        onChange={(e) => set("amount")(e.target.value)}
      />
      <TextInput
        type="date"
        className="order-last col-span-3 sm:order-none sm:col-span-1"
        aria-label="Start date"
        value={row.start}
        onChange={(e) => set("start")(e.target.value)}
      />
      <TextInput
        type="date"
        className="order-last col-span-3 sm:order-none sm:col-span-1"
        aria-label="End date"
        value={row.end}
        onChange={(e) => set("end")(e.target.value)}
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={!removable}
        aria-label="Remove worker"
        className="flex items-center justify-center rounded-xl px-2 text-muted transition hover:bg-danger-soft hover:text-danger disabled:invisible"
      >
        <CloseIcon />
      </button>
    </li>
  );
}

/**
 * The payroll form: one editable row per worker, or a dropped CSV file. Validation is the
 * same parser the CSV import uses, so both paths accept exactly the same payroll.
 */
export function PayrollComposer(props: {
  balance: bigint;
  nowSecs: number;
  ownWorkerId: string | null;
  funding: boolean;
  disabled: boolean;
  /** Resolves true when the payroll was funded, so the form can be cleared. */
  onFund: (rows: PayrollRow[], total: bigint) => Promise<boolean>;
}) {
  const { balance, nowSecs, ownWorkerId, funding, disabled, onFund } = props;
  const [drafts, setDrafts] = useState<Draft[]>([{ ...EMPTY_DRAFT_ROW, id: 0 }]);
  const [dragging, setDragging] = useState(false);
  const nextId = useRef(1);
  const draft = (row: DraftRow): Draft => ({ ...row, id: nextId.current++ });

  const parsed = parseDrafts(drafts, nowSecs);
  const untouched = drafts.every((r) => r.worker === "" && r.amount === "");
  const shortfall = "rows" in parsed && parsed.total > balance ? parsed.total - balance : 0n;

  const updateRow = (row: Draft) => setDrafts((rows) => rows.map((r) => (r.id === row.id ? row : r)));
  const removeRow = (id: number) => setDrafts((rows) => rows.filter((r) => r.id !== id));

  /** Fills the first blank row if there is one, so the form never grows a stray empty line. */
  function addRow(row: DraftRow) {
    setDrafts((rows) => {
      const blank = rows.find((r) => r.worker === "" && r.amount === "");
      return blank ? rows.map((r) => (r === blank ? { ...row, id: blank.id } : r)) : [...rows, draft(row)];
    });
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    const rows = csvToDraftRows(await file.text());
    if (rows.length > 0) setDrafts(rows.map(draft));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    importFile(e.dataTransfer.files[0]);
  }

  async function fund() {
    if (!("rows" in parsed)) return;
    if (await onFund(parsed.rows, parsed.total)) setDrafts([draft(EMPTY_DRAFT_ROW)]);
  }

  return (
    <Card
      title="New payroll"
      aside={
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-muted transition hover:bg-surface-2 hover:text-text">
          <UploadIcon /> Import CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              importFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      }
      className={`transition-shadow ${dragging ? "ring-2 ring-accent" : ""}`}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="mb-2 hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_2rem] gap-2 text-xs font-medium text-muted sm:grid">
          <span>Worker account</span>
          <span>Amount (USDC)</span>
          <span>Start (UTC)</span>
          <span>End (UTC)</span>
        </div>
        <ul className="space-y-2">
          {drafts.map((row) => (
            <RowEditor key={row.id} row={row} onChange={updateRow} onRemove={() => removeRow(row.id)} removable={drafts.length > 1} />
          ))}
        </ul>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="ghost" disabled={drafts.length >= MAX_ROWS} onClick={() => setDrafts((rows) => [...rows, draft(EMPTY_DRAFT_ROW)])}>
            <PlusIcon /> Add worker
          </Button>
          {ownWorkerId && (
            <Button variant="ghost" onClick={() => addRow({ ...EMPTY_DRAFT_ROW, worker: ownWorkerId, amount: DEFAULT_AMOUNT })}>
              <PlusIcon /> Add my worker account
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          Leave start empty to begin now, and end empty for 30 days. You can also drop a CSV here:{" "}
          <span className="num">worker,amount,start,end</span>.
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className={`text-sm ${shortfall > 0n ? "text-danger" : "text-muted"}`}>
          {untouched
            ? "Add a worker to get started."
            : "error" in parsed
              ? parsed.error
              : shortfall > 0n
                ? `You need ${formatUsdc(shortfall)} more USDC to fund this.`
                : summarizeRows(parsed.rows)}
        </p>
        <Button loading={funding} disabled={disabled || !("rows" in parsed) || shortfall > 0n} onClick={fund}>
          Fund payroll
        </Button>
      </div>
    </Card>
  );
}
