"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { GAS_TGAS, ONE_YOCTO, config } from "@/lib/config";
import { fundingMsg, streamsCsv, summarizeRows, type PayrollRow, type StreamRecord } from "@/lib/csv";
import { useLedger, useLog, useNow, useOtherRoleId, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { explain, paidOut, payoutFailure, relayCall, requestTestUsdc } from "@/lib/near";
import { eventsNamed } from "@/lib/outcome";
import { report } from "@/lib/report";
import { parseRequest, requestDraft, requestSummary, type PayRequest } from "@/lib/request";
import { WaitingAnimation } from "../animations";
import { ActivityLog, Toasts } from "../feedback";
import { DownloadIcon } from "../icons";
import { BackupBanner, KeyBackup } from "../KeyBackup";
import { CountAmount } from "../LiveAmount";
import { MoveMoney } from "../MoveMoney";
import { ratePerDay, statusOf } from "../StreamMath";
import { AccountChip, Button, Card, Notice, Skeleton, Stat } from "../ui";
import { PayrollComposer } from "./PayrollComposer";
import { StreamsTable } from "./StreamsTable";

type Action = { kind: "mint" } | { kind: "fund" } | { kind: "cancel"; streamId: number };

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

/** A request-to-be-paid link opened here: say who is asking and what, before the form. */
function RequestNotice({ request }: { request: PayRequest }) {
  return (
    <Notice tone="info">
      <span className="num break-all">{request.worker}</span> asked to be paid {requestSummary(request)}
      {request.note && <> for &ldquo;{request.note}&rdquo;</>}. It is filled in below, from today. Anyone can make a
      request link, so check the account with the person before you fund it.
    </Notice>
  );
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
  const backupCard = useRef<HTMLDivElement>(null);
  const params = useSearchParams();
  const router = useRouter();
  const request = parseRequest(params);
  const requestKey = request ? params.toString() : "";

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
    run({ kind: "mint" }, "Getting test USDC", undefined, async () => {
      const { txHash } = await requestTestUsdc(account.accountId);
      log.add("Received 5,000 test USDC", txHash);
    });

  const fund = (rows: PayrollRow[], total: bigint) =>
    run({ kind: "fund" }, "Funding", false, async () => {
      const args = { receiver_id: config.payday, amount: total.toString(), msg: fundingMsg(rows) };
      const res = await relayCall(keyPair, config.usdc, "ft_transfer_call", args, GAS_TGAS.funding, ONE_YOCTO);
      // Payday emits one stream_created per stream; if it rejects the payroll the token
      // refunds the whole transfer and there are none.
      const outcome = report(log.add, res, (o) =>
        eventsNamed(o, "payday", "stream_created").length === rows.length
          ? { ok: true, text: `Funded ${summarizeRows(rows)}. Salaries are streaming.` }
          : { ok: false, text: `Payroll refunded: ${explain(o, "Payday rejected the payroll")}` },
      );
      if (outcome === "done" && request) router.replace("/employer", { scroll: false });
      return outcome === "done";
    });

  const cancel = (streamId: number) =>
    run({ kind: "cancel", streamId }, "Cancel", undefined, async () => {
      const res = await relayCall(keyPair, config.payday, "cancel", { stream_id: streamId }, GAS_TGAS.payout);
      report(log.add, res, (o) => {
        if (eventsNamed(o, "payday", "stream_canceled").length === 0) {
          return { ok: false, text: `Not cancelled: ${explain(o, "Payday did not cancel the stream")}` };
        }
        const refund = paidOut(o).find((p) => p.receiver === account.accountId);
        if (refund) return { ok: true, text: `Cancelled stream #${streamId}. ${formatUsdc(refund.amount)} USDC refunded to you.` };
        const failed = payoutFailure(o);
        if (failed) return { ok: false, text: `Cancelled stream #${streamId}, but the refund is waiting: ${failed}` };
        return { ok: true, text: `Cancelled stream #${streamId}. Nothing was left to refund.` };
      });
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

      <BackupBanner role="employer" onOpen={() => backupCard.current?.scrollIntoView({ behavior: "smooth" })} />

      <Card>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Stat label="USDC balance">
              <CountAmount value={ledger.balance} />
            </Stat>
            {config.hasFaucet && (
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

      {request && <RequestNotice request={request} />}

      <PayrollComposer
        key={requestKey}
        initialRow={request ? requestDraft(request, Math.floor(now / 1000)) : undefined}
        balance={ledger.balance}
        streamFee={ledger.fees?.stream ?? null}
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

      {(ledger.balance > 0n || ledger.owed > 0n) && (
        <MoveMoney
          keyPair={keyPair}
          accountId={account.accountId}
          streams={[]}
          balance={ledger.balance}
          owed={ledger.owed}
          fees={ledger.fees}
          now={now}
          onDone={ledger.refresh}
          log={log.add}
        />
      )}

      <div ref={backupCard} className="scroll-mt-24">
        <KeyBackup role="employer" accountId={account.accountId} />
      </div>

      <ActivityLog entries={log.entries} />
      <Toasts entries={log.entries} />
    </div>
  );
}
