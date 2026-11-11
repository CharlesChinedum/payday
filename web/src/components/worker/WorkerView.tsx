"use client";

import Link from "next/link";
import { useState } from "react";
import { config } from "@/lib/config";
import type { StreamRecord } from "@/lib/csv";
import { useLedger, useLog, useNow, useRoleAccount } from "@/lib/hooks";
import { formatUsdc } from "@/lib/money";
import { reason, relayCall, withdrawnAmount } from "@/lib/near";
import { WaitingAnimation } from "../animations";
import { ActivityLog, Toasts } from "../feedback";
import { CountAmount, LiveAmount } from "../LiveAmount";
import { availableNow, fmtDate, progress, ratePerDay, statusOf } from "../StreamMath";
import { AccountChip, Button, Card, CopyButton, LiveDot, Notice, Pill, ProgressBar, Skeleton, Stat, shortId } from "../ui";
import { CashOut } from "./CashOut";

const WITHDRAW_GAS_TGAS = 40;

const sumAvailable = (streams: StreamRecord[], nowMs: number) =>
  streams.reduce((sum, s) => sum + availableNow(s, nowMs), 0n);

function BalanceHero(props: { streams: StreamRecord[]; now: number; withdrawing: boolean; onWithdrawAll: () => void }) {
  const { streams, now, withdrawing, onWithdrawAll } = props;
  const streaming = streams.filter((s) => statusOf(s, now) === "streaming");
  const perDay = streaming.reduce((sum, s) => sum + ratePerDay(s), 0n);
  const nothingToWithdraw = sumAvailable(streams, now) === 0n;

  return (
    <section className="relative overflow-hidden rounded-3xl bg-hero p-6 text-hero-ink sm:p-8">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-hero-ink/60">
        {streaming.length > 0 && <LiveDot tone="lime" />}
        Available to withdraw
      </div>
      <p className="mt-3 text-5xl font-semibold tracking-tight sm:text-6xl">
        <LiveAmount amountAt={(nowMs) => sumAvailable(streams, nowMs)} />
      </p>
      <p className="mt-2 text-sm text-hero-ink/60">
        USDC
        {streaming.length > 0 &&
          ` · earning ${formatUsdc(perDay)} a day from ${streaming.length} stream${streaming.length === 1 ? "" : "s"}`}
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button variant="lime" loading={withdrawing} disabled={nothingToWithdraw} onClick={onWithdrawAll}>
          {streams.length > 1 ? "Withdraw all" : "Withdraw"}
        </Button>
        <span className="text-xs text-hero-ink/60">Payday pays the network fee.</span>
      </div>
    </section>
  );
}

function StreamRow(props: { stream: StreamRecord; now: number; busy: boolean; loading: boolean; onWithdraw: () => void }) {
  const { stream, now, busy, loading, onWithdraw } = props;
  const status = statusOf(stream, now);
  return (
    <li className="grid gap-4 py-5 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Stream #{stream.id}</span>
          <Pill tone={status === "streaming" ? "live" : "neutral"}>{status}</Pill>
          <span className="text-muted">
            from <span className="num">{shortId(stream.employer)}</span>
          </span>
        </div>
        <ProgressBar fraction={progress(stream, now)} />
        <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted">
          <span>
            {formatUsdc(BigInt(stream.deposit))} USDC · {formatUsdc(ratePerDay(stream))} a day
          </span>
          <span>
            {fmtDate(stream.start)} – {fmtDate(stream.stop)}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 sm:justify-end">
        <LiveAmount className="text-lg font-medium" amountAt={(nowMs) => availableNow(stream, nowMs)} />
        <Button variant="secondary" loading={loading} disabled={busy || availableNow(stream, now) === 0n} onClick={onWithdraw}>
          Withdraw
        </Button>
      </div>
    </li>
  );
}

function NoSalaryYet({ accountId }: { accountId: string }) {
  const steps = [
    <>
      Copy your Payday account. <CopyButton value={accountId} label="Copy account" />
    </>,
    <>
      Your employer adds it to a payroll. Trying it yourself? Open{" "}
      <Link className="underline underline-offset-4" href="/employer">
        Run payroll
      </Link>{" "}
      in another tab.
    </>,
    <>Come back here and watch your salary arrive, second by second.</>,
  ];
  return (
    <div className="grid items-center gap-6 sm:grid-cols-[10rem_1fr]">
      <WaitingAnimation className="mx-auto h-28 w-40" />
      <div>
        <h3 className="font-semibold tracking-tight">No salary yet</h3>
        <ol className="mt-3 space-y-3 text-sm text-muted">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="num mt-0.5 text-xs text-text">0{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function WorkerSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Setting up your Payday account">
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
      <Skeleton className="h-40 rounded-2xl" />
    </div>
  );
}

export function WorkerView() {
  const account = useRoleAccount("worker");
  const accountId = account.status === "ready" ? account.accountId : null;
  const ledger = useLedger(accountId);
  const now = useNow(1000);
  const log = useLog();
  const [pending, setPending] = useState<number[]>([]);

  if (account.status === "loading") return <WorkerSkeleton />;
  if (account.status === "error") return <Notice tone="error">{account.error}</Notice>;

  const { keyPair } = account;
  const mine = ledger.streams.filter((s) => s.worker === account.accountId);
  const busy = pending.length > 0;

  async function withdrawOne(streamId: number) {
    try {
      const res = await relayCall(keyPair, config.payday, "withdraw", { stream_id: streamId }, WITHDRAW_GAS_TGAS);
      const amount = withdrawnAmount(res);
      if (amount === null) {
        log.add(`Withdrawal failed: ${reason(res, "the transfer was reverted and your balance restored")}`, res.txHash, true);
        return;
      }
      log.add(`Withdrew ${formatUsdc(amount, 6)} USDC from stream #${streamId}. You paid no gas.`, res.txHash);
    } catch (e) {
      log.add(`Withdrawal failed: ${e instanceof Error ? e.message : String(e)}`, undefined, true);
    }
  }

  // Sequential on purpose: each relayed call consumes the next nonce of the same key.
  async function withdraw(streamIds: number[]) {
    setPending(streamIds);
    for (const id of streamIds) {
      await withdrawOne(id);
      setPending((ids) => ids.filter((other) => other !== id));
    }
    setPending([]);
    ledger.refresh();
  }

  const withdrawable = mine.filter((s) => availableNow(s, now) > 0n).map((s) => s.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-4xl sm:text-5xl">Your pay</h1>
          <p className="mt-2 text-muted">Salary that grows every second. Withdraw any time.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <BalanceHero streams={mine} now={now} withdrawing={busy} onWithdrawAll={() => withdraw(withdrawable)} />
        <Card className="flex flex-col justify-between gap-6">
          <Stat label="In your account" hint="USDC you have already withdrawn">
            <CountAmount value={ledger.balance} />
          </Stat>
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-muted">Your Payday account</div>
            <div className="mt-2">
              <AccountChip id={account.accountId} />
            </div>
            <p className="mt-2 text-xs text-muted">Give this to your employer so they can pay you.</p>
          </div>
        </Card>
      </div>

      <Card title="Salary streams">
        {!ledger.loaded ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : mine.length === 0 ? (
          <NoSalaryYet accountId={account.accountId} />
        ) : (
          <ul className="divide-y divide-border">
            {mine.map((s) => (
              <StreamRow
                key={s.id}
                stream={s}
                now={now}
                busy={busy}
                loading={pending.includes(s.id)}
                onWithdraw={() => withdraw([s.id])}
              />
            ))}
          </ul>
        )}
        {ledger.error && <p className="mt-4 text-sm text-danger">Could not read the chain: {ledger.error}</p>}
      </Card>

      {mine.length > 0 && (
        <CashOut keyPair={keyPair} accountId={account.accountId} streams={mine} now={now} onDone={ledger.refresh} log={log.add} />
      )}

      <ActivityLog entries={log.entries} />
      <Toasts entries={log.entries} />
    </div>
  );
}
