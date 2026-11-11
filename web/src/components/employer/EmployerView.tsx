"use client";

import { useState } from "react";
import { config, ONE_YOCTO } from "@/lib/config";
import { fundingMsg, streamsCsv, summarizeRows, type PayrollRow, type StreamRecord } from "@/lib/csv";
import { useLedger, useLog, useNow, useOtherRoleId, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { emitted, reason, relayCall } from "@/lib/near";
import { eventsNamed } from "@/lib/outcome";
import { WaitingAnimation } from "../animations";
import { ActivityLog, Toasts } from "../feedback";
import { DownloadIcon } from "../icons";
import { CountAmount } from "../LiveAmount";
import { ratePerDay, statusOf } from "../StreamMath";
import { AccountChip, Button, Card, Notice, Skeleton, Stat } from "../ui";
import { PayrollComposer } from "./PayrollComposer";
import { StreamsTable } from "./StreamsTable";

const TEST_MINT_UNITS = 5_000_000_000n;
const MINT_GAS_TGAS = 10;
const CANCEL_GAS_TGAS = 40;

type Action = { kind: "mint" } | { kind: "fund" } | { kind: "cancel"; streamId: number };

/** Registering each worker with the token costs gas, so funding gas grows with the batch. */
function fundingGasTgas(streamCount: number): number {
  return Math.min(250, 60 + 8 * streamCount);
}

function downloadCsv(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function payrollTotals(streams: StreamRecord[], now: number) {
  const streaming = streams.filter((s) => statusOf(s, now) === "streaming");
  return {
    committed: streams.reduce((sum, s) => sum + BigInt(s.deposit) - BigInt(s.withdrawn), 0n),
    perDay: streaming.reduce((sum, s) => sum + ratePerDay(s), 0n),
    people: new Set(streaming.map((s) => s.worker)).size,
  };
}

function EmployerSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Setting up your Payday account">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-32 rounded-2xl" />
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

export function EmployerView() {
  const account = useRoleAccount("employer");
  const accountId = account.status === "ready" ? account.accountId : null;
  const ownWorkerId = useOtherRoleId("worker");
  const ledger = useLedger(accountId);
  const now = useNow(1000);
  const log = useLog();
  const [action, setAction] = useState<Action | null>(null);

  if (account.status === "loading") return <EmployerSkeleton />;
  if (account.status === "error") return <Notice tone="error">{account.error}</Notice>;

  const { keyPair } = account;
  const mine = ledger.streams.filter((s) => s.employer === account.accountId);
  const totals = payrollTotals(mine, now);
  const busy = action !== null;

  /** Runs one relayed action at a time and reports anything thrown on the way. */
  async function run<T>(next: Action, label: string, fallback: T, work: () => Promise<T>): Promise<T> {
    setAction(next);
    try {
      return await work();
    } catch (e) {
      log.add(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
      return fallback;
    } finally {
      setAction(null);
      ledger.refresh();
    }
  }

  const mint = () =>
    run({ kind: "mint" }, "Mint", undefined, async () => {
      const args = { account_id: account.accountId, amount: TEST_MINT_UNITS.toString() };
      const res = await relayCall(keyPair, config.usdc, "mint", args, MINT_GAS_TGAS);
      if (emitted(res, "nep141", "ft_mint")) log.add(`Received ${formatUsdc(TEST_MINT_UNITS)} test USDC`, res.txHash);
      else log.add(`Mint failed: ${reason(res, "the token did not mint")}`, res.txHash, true);
    });

  const fund = (rows: PayrollRow[], total: bigint) =>
    run({ kind: "fund" }, "Funding", false, async () => {
      const args = { receiver_id: config.payday, amount: total.toString(), msg: fundingMsg(rows) };
      const res = await relayCall(keyPair, config.usdc, "ft_transfer_call", args, fundingGasTgas(rows.length), ONE_YOCTO);
      // Payday emits one stream_created per stream; if it rejects the payroll the token
      // refunds the whole transfer and there are none.
      const created = res.error === undefined ? eventsNamed(res, "payday", "stream_created").length : 0;
      if (created !== rows.length) {
        log.add(`Payroll refunded: ${reason(res, "Payday rejected the payroll")}`, res.txHash, true);
        return false;
      }
      log.add(`Funded ${summarizeRows(rows)}. Salaries are streaming.`, res.txHash);
      return true;
    });

  const cancel = (streamId: number) =>
    run({ kind: "cancel", streamId }, "Cancel", undefined, async () => {
      const res = await relayCall(keyPair, config.payday, "cancel", { stream_id: streamId }, CANCEL_GAS_TGAS);
      if (emitted(res, "payday", "stream_canceled")) log.add(`Cancelled stream #${streamId}. Unearned salary is back in your balance.`, res.txHash);
      else log.add(`Cancel failed: ${reason(res, "Payday did not cancel the stream")}`, res.txHash, true);
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-4xl sm:text-5xl">Payroll</h1>
          <p className="mt-2 text-muted">Fund every salary in one transfer. Each one streams by the second.</p>
        </div>
        <div className="text-right text-xs text-muted">
          <div className="mb-1">Your employer account</div>
          <AccountChip id={account.accountId} />
        </div>
      </div>

      <Card>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Stat label="USDC balance">
              <CountAmount value={ledger.balance} />
            </Stat>
            {config.networkId === "testnet" && (
              <Button className="mt-3" variant="secondary" loading={action?.kind === "mint"} disabled={busy} onClick={mint}>
                Get 5,000 test USDC
              </Button>
            )}
          </div>
          <Stat label="Committed to salaries" hint="Held by the contract for your workers">
            <CountAmount value={totals.committed} />
          </Stat>
          <Stat label="Paying out" hint="Across all live streams">
            <span className="num">{formatUsdc(totals.perDay)}</span>
            <span className="text-base font-normal text-muted"> / day</span>
          </Stat>
          <Stat label="People on payroll" hint="With a live stream right now">
            <span className="num">{totals.people}</span>
          </Stat>
        </div>
      </Card>

      <PayrollComposer
        balance={ledger.balance}
        nowSecs={Math.floor(now / 1000)}
        ownWorkerId={ownWorkerId}
        funding={action?.kind === "fund"}
        disabled={busy}
        onFund={fund}
      />

      <Card
        title="Streams you pay"
        aside={
          mine.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => downloadCsv(`payday-${new Date().toISOString().slice(0, 10)}.csv`, streamsCsv(mine, new Date()))}
            >
              <DownloadIcon /> Export CSV
            </Button>
          )
        }
      >
        {!ledger.loaded ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : mine.length === 0 ? (
          <div className="grid items-center gap-6 sm:grid-cols-[10rem_1fr]">
            <WaitingAnimation className="mx-auto h-28 w-40" />
            <div>
              <h3 className="font-semibold tracking-tight">No one is being paid yet</h3>
              <p className="mt-2 text-sm text-muted">
                Get test USDC, add a worker above and fund the payroll. Their salary starts streaming in the same
                transaction.
              </p>
            </div>
          </div>
        ) : (
          <StreamsTable
            streams={mine}
            now={now}
            disabled={busy}
            cancellingId={action?.kind === "cancel" ? action.streamId : null}
            onCancel={cancel}
          />
        )}
        {ledger.error && <p className="mt-4 text-sm text-danger">Could not read the chain: {ledger.error}</p>}
      </Card>

      <ActivityLog entries={log.entries} />
      <Toasts entries={log.entries} />
    </div>
  );
}
